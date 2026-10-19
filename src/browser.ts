import { chromium, type BrowserContext } from 'playwright';
import { spawn } from 'node:child_process';
import { CliError } from './errors.js';
import { API_ORIGIN, Api, trustedAuthUrl } from './api.js';
import { credentialFor, Store } from './store.js';

export async function launch(store: Store) {
  try { return await chromium.launchPersistentContext(store.profile, { channel: 'chrome', headless: false }); }
  catch { throw new CliError('Chromeを起動できません。Google Chromeがインストールされ、専用プロファイルが使用中でないことを確認してください。', 'BROWSER'); }
}
export function cancellation(parent?: AbortSignal, timeout = 300_000) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new CliError('操作をキャンセルしました。', 'CANCELLED', 130));
  const fromParent = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(new CliError('5分以内に完了しませんでした。再実行してください。', 'TIMEOUT')), timeout);
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  parent?.addEventListener('abort', fromParent, { once: true });
  if (parent?.aborted) fromParent();
  return { signal: controller.signal, abort: (reason: Error) => controller.abort(reason), dispose() { clearTimeout(timer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); parent?.removeEventListener('abort', fromParent); } };
}
export function waitForToken(context: BrowserContext, signal: AbortSignal, validate: (token: string) => Promise<unknown> = token => new Api(token).account()): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const pending = new Set<string>();
    const cleanup = () => { context.off('request', request); context.off('close', close); signal.removeEventListener('abort', abort); };
    const finish = (error?: Error, token?: string) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(token!);
    };
    const close = () => finish(new CliError('Chromeが閉じられました。zenid loginを再実行してください。', 'BROWSER_CLOSED'));
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new CliError('操作をキャンセルしました。', 'CANCELLED'));
    const request = (req: { url(): string; headers(): Record<string, string> }) => {
      const url = new URL(req.url());
      if (url.origin !== API_ORIGIN || url.pathname !== '/accounts') return;
      const token = req.headers().authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
      if (!token || pending.has(token)) return;
      pending.add(token);
      void validate(token).then(() => finish(undefined, token), () => { pending.delete(token); });
    };
    context.on('request', request); context.on('close', close); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function login(store: Store) {
  return store.locked(async () => {
    const lifecycle = cancellation();
    let context: BrowserContext | undefined;
    const closeOnAbort = () => { void context?.close().catch(() => {}); };
    try {
      context = await launch(store);
      lifecycle.signal.addEventListener('abort', closeOnAbort, { once: true });
      lifecycle.signal.throwIfAborted();
      const tokenPromise = waitForToken(context, lifecycle.signal);
      // Attach rejection handling before navigation, which may outlive cancellation.
      void tokenPromise.catch(() => {});
      const page = context.pages()[0] ?? await context.newPage();
      const navigationFailure = page.goto('https://zenid.jp/home', { waitUntil: 'domcontentloaded', timeout: 30_000 })
        .then(() => new Promise<never>(() => {}));
      const token = await Promise.race([tokenPromise, navigationFailure]);
      lifecycle.signal.throwIfAborted();
      await store.save(credentialFor(token));
      return { authenticated: true };
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('ログイン画面を開けませんでした。zenid loginを再実行してください。', 'BROWSER');
    } finally { lifecycle.signal.removeEventListener('abort', closeOnAbort); lifecycle.dispose(); await context?.close().catch(() => {}); }
  });
}
export async function openBrowser(url: string) {
  trustedAuthUrl(url);
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    child.once('error', () => reject(new CliError('ブラウザを開けませんでした。', 'BROWSER')));
    child.once('exit', code => code === 0 ? resolve() : reject(new CliError('ブラウザを開けませんでした。', 'BROWSER')));
  });
}
export async function enrollmentBrowser(store: Store, action: (navigate: (url: string) => Promise<void>, signal: AbortSignal) => Promise<unknown>) {
  return store.locked(async () => {
    const lifecycle = cancellation();
    let context: BrowserContext | undefined;
    const closed = () => lifecycle.abort(new CliError('Chromeが閉じられました。登録の完了を確認できませんでした。', 'BROWSER_CLOSED'));
    try {
      context = await launch(store);
      const page = context.pages()[0] ?? await context.newPage();
      context.on('close', closed);
      return await action(async url => {
        trustedAuthUrl(url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      }, lifecycle.signal);
    } finally {
      context?.off('close', closed);
      lifecycle.dispose(); await context?.close().catch(() => {});
    }
  });
}
