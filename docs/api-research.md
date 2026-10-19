# ZENID内部APIの調査記録

調査日: 2026-10-19。Chrome DevTools MCPで画面、通信、配信JavaScriptを確認した。非公式APIの観測結果であり、提供元による互換性の保証はない。

## 実通信で確認

| メソッド・接続先 | 結果・用途 |
| --- | --- |
| `GET https://mypage-api.zenid.jp/accounts` | 200。アカウント、メール、パスワード変更URL、所属一覧 |
| `GET https://mypage-api.zenid.jp/authentication-methods` | 200。認証方法の配列 |
| `POST https://auth.zenid.jp/oauth/token` | Authorization Code + PKCE。Bearer、`expires_in: 86400`。観測した応答にrefresh tokenなし |

APIには`Authorization: Bearer …`と`Content-Type: application/json`が付与される。Datadog用ヘッダーはCLIでは送信しない。

`/accounts`には`id`、`email`、`emailVerified`、`changePasswordUrl`、`memberships`がある。所属には組織、UNIX秒の`joinedAt` / `leftAt`、動的なプロフィール項目、役割割当がある。現在の所属は`leftAt: null`。画面は学校メールを主メールとして表示する場合があり、APIの`email`は画面上のサブメールに相当する場合がある。

## 配信JavaScriptから確認

対象: `https://zenid.jp/assets/index-CY4FpZPu.js`。下記の更新操作は実アカウントへ送信していない。

| メソッド・パス | 入力・挙動 |
| --- | --- |
| `PUT /accounts` | JSON `{email: string}` |
| `POST /verify-email` | 本文なし |
| `POST /authentication-method-enrollments` | 本文なし。`Location`から登録URLを取得 |
| `DELETE /authentication-methods/{authenticationMethodId}` | IDをパスに指定 |

メール入力では`nnn.ac.jp`、`nnn.ed.jp`、`n-jr.jp`、`student.zen.ac.jp`が除外されていた。変更APIは400（利用不可）と409（保護者メールとの競合）の分岐がある。

画面のMFAリセットは登録URL取得→既存認証方法の削除→登録URLを開く順序。画面は先頭の方法を対象としていたが、CLIはID指定を必須にする。CLIは新しい認証方法の出現を確認して完了とする。

## 認証

Auth0 SPA SDK、ドメイン`auth.zenid.jp`、audience `https://mypage-api.zenid.jp/`を確認した。localStorageにはトークンが見つからず、CLIは特定のストレージ構造に依存しない。

既存Webクライアントで`http://localhost:8976/callback`を試すと、`unauthorized_client` / `Callback URL mismatch`になった。すべてのコールバック候補を調べたものではない。CLIでは専用Chromeで通常のWebログインを行い、マイページへのリクエストからトークンを取得する。

アカウント統合APIも配信コードにあるが初版の対象外。実データ、トークン、認証コード、Cookie、一時URLのチケットはこの資料とテストfixtureには収録しない。

## CLIでの動作確認

2026-10-19、実装した`login`で専用Chromeを開き、ユーザーの画面操作後にトークン取得・アカウント取得・認証情報の保存が成功した。続いて`auth status`、`account show`、`memberships list`、`memberships list --past`、`mfa list`を`--json`で実行し、実APIで成功した。認証ファイルの権限`0600`とログイン後のロック解除も確認した。

メール変更・確認メール再送・MFA登録／リセットは実環境では実行せず、モックで検証した。型チェック、ビルド、20件の自動テスト、および`npm link`後の`zenid --help`が成功した。
