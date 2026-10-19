import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError } from './errors.js';
import type { Credential } from './types.js';
export function defaultDataDir() {
  const root = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(root || homedir(), 'zenid-cli');
}
export class Store {
  constructor(public dir = defaultDataDir()) {}
  get profile() { return join(this.dir, 'chrome-profile'); }
  async init() { await mkdir(this.dir, { recursive: true, mode: 0o700 }); }
  async read(): Promise<Credential | null> {
    try {
      const data = JSON.parse(await readFile(join(this.dir, 'credentials.json'), 'utf8'));
      if (typeof data.token !== 'string' || !data.token || !(data.expiresAt === null || typeof data.expiresAt === 'number')) throw new Error();
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CliError('保存された認証情報を読み込めません。zenid loginを実行してください。', 'CREDENTIALS');
    }
  }
  async token() {
    const credential = await this.read();
    if (!credential || (credential.expiresAt !== null && credential.expiresAt <= Date.now() + 30_000)) {
      throw new CliError('ログインが必要です。zenid loginを実行してください。', 'UNAUTHENTICATED');
    }
    return credential.token;
  }
  async save(credential: Credential) {
    await this.init();
    const path = join(this.dir, `credentials.${process.pid}.tmp`);
    const file = await open(path, 'wx', 0o600);
    try {
      try { await file.writeFile(JSON.stringify(credential)); } finally { await file.close(); }
      await rename(path, join(this.dir, 'credentials.json'));
    } finally { await rm(path, { force: true }); }
  }
  async clear() {
    await rm(join(this.dir, 'credentials.json'), { force: true });
    await rm(this.profile, { recursive: true, force: true });
  }
  async locked<T>(action: () => Promise<T>): Promise<T> {
    await this.init();
    const path = join(this.dir, 'browser.lock');
    let lock;
    try { lock = await open(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new CliError(`別のブラウザ操作が実行中です。終了済みの場合は ${path} を削除してください。`, 'LOCKED');
    }
    try { await lock.writeFile(String(process.pid)); return await action(); }
    finally { await lock.close(); await rm(path, { force: true }); }
  }
}
export function credentialFor(token: string): Credential {
  let expiresAt: number | null = null;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp)) expiresAt = payload.exp * 1000;
  } catch { /* opaque tokens are validated through the API */ }
  return { token, expiresAt };
}
