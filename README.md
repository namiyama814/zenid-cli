# zenid-cli

ZEN IDのアカウント・所属情報の確認とアカウント設定を行う非公式CLIです。TypeScript製。npmへの公開は行いません。

## インストール

Node.js 22以上とデスクトップ版Google Chromeが必要です。Playwrightの`chrome`チャンネルでChromeを検出します。

```sh
git clone https://github.com/namiyama814/zenid-cli.git
cd zenid-cli
npm ci
npm run build
npm link
zenid --help
```

`npm link`を使わない場合は`node dist/bin.js`で実行できます。Chromiumの追加ダウンロードは不要です。開発時は`npm test`と`npm run typecheck`を使います。

## ログイン

```sh
zenid login
zenid auth status
```

専用のChromeウィンドウが開きます。ZENIDの画面でメールアドレス・パスワード・2段階認証を入力してください。CLIはマイページAPIへの通信を検知し、取得したトークンでアカウント情報を取得できたらログインを完了します。通常のChromeプロファイルとは独立しています。

待機時間は5分です。ウィンドウを閉じるかCtrl+Cでキャンセルできます。期限切れになったら`zenid login`を再実行してください。Webクライアントでは試したlocalhostコールバックURLが拒否されたため、専用Chromeを使用します。

## コマンド

```sh
zenid account show
zenid account show --json
zenid memberships list
zenid memberships list --past --json
zenid mfa list
zenid email set you@example.com
zenid email verify
zenid password change
zenid mfa enroll
zenid mfa reset 'phone|対象ID'
zenid logout
```

`memberships list`は現在の所属、`--past`は過去の所属を表示します。プロフィール・役割の項目も含みます。`account show`の`email`はAPIが返すメールアドレスで、学校アカウントでは画面のサブメールに相当する場合があります。

メール変更・確認メール再送・MFA操作には確認が入ります。非対話実行では、操作内容を確認のうえ`--yes`を指定してください。

```sh
zenid email set you@example.com --yes --json
```

MFAリセットは指定した認証方法を解除した後、Chromeで再登録します。新しい認証方法をAPIで確認できるまで成功としません。途中で終了すると解除だけが完了している場合があります。その場合はZENIDのマイページで設定を完了してください。登録済みの方法がある場合は`enroll`ではなく`reset <id>`を使用します。

パスワード変更はブラウザで完了させます。CLIの`opened: true`は画面を開いたことだけを示します。

`--json`は結果を標準出力へ出します。案内とエラーは標準エラーへ出します。通常エラーは終了コード1、引数エラーは2、ログイン中のシグナルキャンセルは130です。通常エラーのJSON形式は`{"error":{"code":"…","message":"…"}}`です。ヘルプ・引数エラーはCommanderのテキスト表示です。

更新APIは自動再送しません。通信タイムアウトは30秒です。タイムアウトした更新操作は結果が不明な場合があるため、再実行前にマイページで確認してください。

## 認証情報の保存

| OS | 保存先 |
| --- | --- |
| macOS | `~/Library/Application Support/zenid-cli/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/zenid-cli/` |
| Windows | `%LOCALAPPDATA%/zenid-cli/` |

`credentials.json`にトークンと有効期限、`chrome-profile/`に専用Chromeの状態を保存します。POSIXでは新規ディレクトリを`0700`、認証ファイルを`0600`で作成します。WindowsではOSのユーザープロファイルのアクセス制御に従います。保存内容は暗号化していません。

ブラウザ操作とログアウトは`browser.lock`で排他制御します。強制終了でロックが残った場合は該当CLIと専用Chromeの終了を確認してから`browser.lock`を削除してください。`zenid logout`はトークンと専用プロファイルを削除します。他のブラウザのセッションやサーバー上のトークンは失効させません。

トークン・パスワード変更URL・MFA登録URLは出力しません。アカウント情報の出力にはメール・学籍などの個人情報が含まれます。

## APIについて

ZENID公式のCLIではありません。内部APIの変更で動かなくなる可能性があります。連携サービス側の操作、アカウント統合・削除には対応していません。

Chrome DevTools MCPによる調査結果は[API調査記録](docs/api-research.md)に記載しています。参照APIは実通信で確認し、更新操作は配信JavaScriptの確認とモックテストに留めています。
