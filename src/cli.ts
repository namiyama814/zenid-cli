import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { Api, publicAccount, trustedAuthUrl } from './api.js';
import { Store } from './store.js';
import { login, openBrowser, enrollmentBrowser } from './browser.js';
import { enroll } from './mfa.js';
import { CliError, safeError } from './errors.js';

export interface Dependencies {
  store: Store;
  api: () => Promise<Api>;
  login: () => Promise<unknown>;
  logout: () => Promise<unknown>;
  open: (url: string) => Promise<void>;
  mfa: (api: Api, id?: string) => Promise<unknown>;
  interactive: boolean;
  confirm: (message: string) => Promise<boolean>;
  out: (value: string) => void;
  err: (value: string) => void;
}
export function defaults(): Dependencies {
  const store = new Store();
  return {
    store, api: async () => new Api(await store.token()), login: () => login(store),
    logout: () => store.locked(async () => { await store.clear(); return { authenticated: false }; }),
    open: openBrowser,
    mfa: (api, id) => enrollmentBrowser(store, (navigate, signal) => enroll(api, navigate, signal, id)),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    confirm: async message => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try { return /^(y|yes)$/i.test((await rl.question(`${message} [y/N] `)).trim()); }
      finally { rl.close(); }
    },
    out: value => process.stdout.write(`${value}\n`), err: value => process.stderr.write(`${value}\n`),
  };
}
export function createProgram(deps: Dependencies = defaults()) {
  const program = new Command().name('zenid').description('ZEN ID CLI（非公式）').version('0.1.0')
    .option('--json', 'JSONで出力').option('-y, --yes', '確認を省略');
  program.configureOutput({ writeOut: value => deps.out(value.trimEnd()), writeErr: value => deps.err(value.trimEnd()) });
  program.exitOverride();
  const emit = (result: unknown, message?: string) => deps.out(program.opts().json ? JSON.stringify(result) : message ?? JSON.stringify(result, null, 2));
  const confirm = async (message: string) => {
    if (program.opts().yes) return;
    if (!deps.interactive) throw new CliError('この操作には確認が必要です。内容を確認して--yesを指定してください。', 'CONFIRMATION_REQUIRED');
    if (!await deps.confirm(message)) throw new CliError('操作をキャンセルしました。', 'CANCELLED');
  };
  program.command('login').description('Chromeでログイン').action(async () => {
    deps.err('ChromeでZENIDにログインしてください。完了を最大5分間待ちます。');
    emit(await deps.login(), 'ログインしました。');
  });
  program.command('logout').description('保存したログイン情報を削除').action(async () => emit(await deps.logout(), 'ログアウトしました。'));
  program.command('auth').description('認証状態').command('status').action(async () => {
    const api = await deps.api(); const account = await api.account();
    emit({ authenticated: true, accountId: account.id }, `ログイン中（${account.id}）`);
  });
  program.command('account').description('アカウント情報').command('show').action(async () => emit(publicAccount(await (await deps.api()).account())));
  program.command('memberships').description('所属情報').command('list').option('--past', '過去の所属を表示').action(async options => {
    const account = await (await deps.api()).account();
    emit(account.memberships.filter(membership => options.past ? membership.leftAt !== null : membership.leftAt === null));
  });
  const email = program.command('email').description('メール設定');
  email.command('set <email>').action(async (value: string) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new CliError('メールアドレスの形式を確認してください。', 'INVALID_EMAIL');
    const domain = value.split('@')[1].toLowerCase();
    if (['nnn.ac.jp', 'nnn.ed.jp', 'n-jr.jp', 'student.zen.ac.jp'].includes(domain)) throw new CliError('このドメインはサブメールアドレスに使用できません。', 'INVALID_EMAIL');
    await confirm(`メールアドレスを ${value} に変更しますか？`);
    await (await deps.api()).setEmail(value); emit({ updated: true }, 'メールアドレスを変更しました。確認メールに従って認証してください。');
  });
  email.command('verify').action(async () => {
    await confirm('確認メールを再送しますか？'); await (await deps.api()).verifyEmail(); emit({ sent: true }, '確認メールを送信しました。');
  });
  program.command('password').description('パスワード設定').command('change').action(async () => {
    const account = await (await deps.api()).account(); await deps.open(trustedAuthUrl(account.changePasswordUrl));
    emit({ opened: true }, 'ブラウザでパスワードを変更してください。');
  });
  const mfa = program.command('mfa').description('2段階認証');
  mfa.command('list').action(async () => emit(await (await deps.api()).methods()));
  mfa.command('enroll').action(async () => {
    await confirm('2段階認証の登録画面を開きますか？');
    deps.err('Chromeで2段階認証を設定してください。完了を最大5分間待ちます。');
    emit(await deps.mfa(await deps.api()), '2段階認証の登録を確認しました。');
  });
  mfa.command('reset <id>').action(async (id: string) => {
    await confirm('指定した2段階認証を解除して再登録します。続けますか？');
    deps.err('Chromeで2段階認証を再登録してください。完了を最大5分間待ちます。');
    emit(await deps.mfa(await deps.api(), id), '2段階認証の再登録を確認しました。');
  });
  return program;
}
export async function run(argv: string[], deps = defaults()): Promise<number> {
  try { await createProgram(deps).parseAsync(argv, { from: 'user' }); return 0; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('commander.')) {
      return ['commander.helpDisplayed', 'commander.version', 'commander.help'].includes(String(error.code)) ? 0 : 2;
    }
    const failure = safeError(error);
    deps.err(argv.includes('--json') ? JSON.stringify({ error: { code: failure.code, message: failure.message } }) : failure.message);
    return failure.exitCode;
  }
}
