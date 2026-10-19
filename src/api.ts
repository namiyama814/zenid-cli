import { CliError } from './errors.js';
import type { Account, AuthenticationMethod } from './types.js';
export const API_ORIGIN = 'https://mypage-api.zenid.jp';
export class Api {
  constructor(private token: string, private fetcher: typeof fetch = fetch, private base = API_ORIGIN) {}
  async request(method: string, path: string, body?: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000), redirect: 'manual',
      });
    } catch { throw new CliError('APIに接続できませんでした。時間をおいて再実行してください。', 'NETWORK'); }
    if (!response.ok) {
      const errors: Record<number, [string, string]> = {
        400: ['入力内容を確認してください。', 'BAD_REQUEST'],
        401: ['認証が切れています。zenid loginを実行してください。', 'UNAUTHENTICATED'],
        403: ['この操作を実行する権限がありません。', 'FORBIDDEN'],
        409: ['登録情報が競合しています。別のメールアドレスなどを指定してください。', 'CONFLICT'],
        429: ['アクセスが集中しています。時間をおいて再実行してください。', 'RATE_LIMITED'],
      };
      const [message, code] = errors[response.status] ?? [`APIエラー（HTTP ${response.status}）。`, 'API_ERROR'];
      throw new CliError(message, code);
    }
    return response;
  }
  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(method, path, body);
    try { return await response.json() as T; }
    catch { throw new CliError('APIの応答形式が変わっています。', 'INVALID_RESPONSE'); }
  }
  async account() {
    const value = await this.json<Account>('GET', '/accounts');
    if (!value || typeof value.id !== 'string' || typeof value.email !== 'string' || !Array.isArray(value.memberships)) {
      throw new CliError('アカウントAPIの応答形式が変わっています。', 'INVALID_RESPONSE');
    }
    return value;
  }
  async methods() {
    const value = await this.json<AuthenticationMethod[]>('GET', '/authentication-methods');
    if (!Array.isArray(value) || value.some(method => !method || typeof method.id !== 'string' || typeof method.type !== 'string')) {
      throw new CliError('認証方法APIの応答形式が変わっています。', 'INVALID_RESPONSE');
    }
    return value;
  }
  async setEmail(email: string) { await this.request('PUT', '/accounts', { email }); }
  async verifyEmail() { await this.request('POST', '/verify-email'); }
  async enrollment() {
    const response = await this.request('POST', '/authentication-method-enrollments');
    return trustedAuthUrl(response.headers.get('Location'));
  }
  async deleteMethod(id: string) { await this.request('DELETE', `/authentication-methods/${encodeURIComponent(id)}`); }
}
export function trustedAuthUrl(value: string | null | undefined): string {
  try {
    const url = new URL(value ?? '');
    if (url.origin === 'https://auth.zenid.jp' && !url.username && !url.password) return url.href;
  } catch { /* handled below */ }
  throw new CliError('認証画面のURLが無効です。操作を中止しました。', 'INVALID_AUTH_URL');
}
export function publicAccount(account: Account) {
  const { changePasswordUrl: _, ...result } = account;
  return result;
}
