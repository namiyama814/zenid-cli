import { setTimeout as delay } from 'node:timers/promises';
import { Api } from './api.js';
import { CliError } from './errors.js';

export async function waitForEnrollment(api: Pick<Api, 'methods'>, previous: Set<string>, signal: AbortSignal, pause = (signal: AbortSignal) => delay(2_000, undefined, { signal })) {
  while (true) {
    if (signal.aborted) throw signal.reason ?? new CliError('再登録が完了していません。', 'CANCELLED');
    const methods = await api.methods();
    signal.throwIfAborted();
    const added = methods.find(method => !previous.has(method.id));
    if (added) return { completed: true, method: added };
    try { await pause(signal); }
    catch { throw signal.reason ?? new CliError('再登録が完了していません。', 'CANCELLED'); }
  }
}
export async function enroll(api: Api, navigate: (url: string) => Promise<void>, signal: AbortSignal, resetId?: string) {
  const previous = await api.methods();
  if (resetId !== undefined && !previous.some(method => method.id === resetId)) throw new CliError('指定した認証方法は存在しません。zenid mfa listで確認してください。', 'NOT_FOUND');
  if (resetId === undefined && previous.length) throw new CliError('登録済みです。変更する場合はzenid mfa reset <id>を実行してください。', 'ALREADY_ENROLLED');
  const url = await api.enrollment();
  let deleted = false;
  try {
    signal.throwIfAborted();
    if (resetId !== undefined) { await api.deleteMethod(resetId); deleted = true; }
    signal.throwIfAborted();
    await navigate(url);
    return await waitForEnrollment(api, new Set(previous.map(method => method.id)), signal);
  } catch (error) {
    if (deleted) throw new CliError('既存の認証方法は解除されましたが、再登録の完了を確認できませんでした。ZENIDのマイページで2段階認証を設定してください。', 'MFA_INCOMPLETE');
    throw error;
  }
}
