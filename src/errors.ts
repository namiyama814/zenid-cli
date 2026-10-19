export class CliError extends Error {
  constructor(message: string, public code = 'ERROR', public exitCode = 1) { super(message); }
}
export function safeError(error: unknown): CliError {
  return error instanceof CliError ? error : new CliError('処理に失敗しました。ネットワークとChromeの状態を確認してください。');
}
