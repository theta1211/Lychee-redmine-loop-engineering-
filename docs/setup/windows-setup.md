# Windows環境構築ガイド

対象読者：この仕組みを実際にWindowsサーバー（またはタスクスケジューラが使えるWindows PC）へ
導入する担当者。`setup.bat`と`scripts/*.ps1`で自動化できる部分と、手動でしか行えない部分を分けて説明する。

> **注記**：`setup.bat`・`scripts/setup-iis.ps1`・`scripts/register-task.ps1`は、
> IIS/iisnode/タスクスケジューラの公開されている仕様・標準的な構築手順に基づいて作成しているが、
> 実際のWindows環境では未実行（本リポジトリの開発環境はLinuxのため）。
> 導入時は必ず「6. 動作確認チェックリスト」を上から順に確認すること。

## 1. 全体の流れ

```
① 前提ソフトウェアの導入（手動・一部Windowsの機能追加が必要）
        ↓
② npm install / npm run build                 … setup.bat の「1」
        ↓
③ config/config.json の作成・編集              … setup.bat の「2」
        ↓
④ IISサイトの構築（Web管理アプリ）             … setup.bat の「3」（要 管理者権限）
        ↓
⑤ タスクスケジューラへの登録（実行エンジン）    … setup.bat の「4」（要 管理者権限）
        ↓
⑥ 動作確認
```

## 2. 前提ソフトウェアの導入（手動）

自動インストールはしない。ライセンス同意や再起動を伴うものが多く、
無人でのサイレントインストールは事故のもとになるため。

| ソフトウェア | 用途 | 入手方法 |
|---|---|---|
| Node.js（LTS） | Web管理アプリ・実行エンジンの実行基盤 | https://nodejs.org/ からLTS版をインストール |
| Git for Windows | 対象リポジトリの操作 | https://git-scm.com/download/win |
| GitHub Copilot CLI | 実装・レビューAI本体 | 実行エンジン専用ユーザーでインストールし、`copilot`コマンドでログインしておく |
| IIS（Webサーバー役割） | Web管理アプリのホスティング・Windows認証 | サーバーマネージャー › 役割と機能の追加 |
| Windows認証（IIS機能） | IIS本体の追加機能として同時に有効化 | 役割と機能の追加ウィザード内「Webサーバー › セキュリティ › Windows認証」にチェック |
| iisnode | IIS上でNode.jsアプリを動かすためのモジュール | https://github.com/Azure/iisnode/releases （環境に合ったx64/x86インストーラ） |
| URL Rewrite Module | ヘッダー注入・ルーティングに使用 | https://www.iis.net/downloads/microsoft/url-rewrite |

IISの役割を追加する際は、最低限以下にチェックを入れる。

- Webサーバー › アプリケーション開発 › （既定のままで可）
- Webサーバー › セキュリティ › **Windows認証**
- 管理ツール › IIS管理コンソール

### Redmine APIキーの取得

Redmineに管理者以外でもよいので実行エンジン用のアカウントでログインし、
「個人設定」画面の「APIアクセスキー」から取得する（未表示の場合は管理者に
「RESTによるWebサービスを有効にする」設定を依頼する）。

### 実行エンジン専用ユーザーの準備

タスクスケジューラで実行エンジンを動かす**専用のWindowsユーザー**を1つ用意し、
そのユーザーで一度サインインして以下を済ませておく（詳細は
`docs/design/detailed-design.md`の「実行環境の前提」を参照）。

1. `copilot`コマンドでGitHub Copilot CLIにログインする
2. 対象Gitリポジトリに対して、コマンドラインから一度 `git push` できることを確認する
   （Git Credential Managerに資格情報を保存させる）
3. 対象リポジトリをこのユーザーが読み書きできる場所へクローンしておく

## 3. 自動セットアップ（setup.bat）

リポジトリ直下の `setup.bat` をダブルクリックすると、番号選択式のメニューが起動する。

| 番号 | 内容 | 管理者権限 |
|---|---|---|
| 1 | 前提コマンド（node/git/copilot）の検出、`npm install`、`npm run build` | 不要 |
| 2 | `config/config.example.json` を `config/config.json` にコピーし、メモ帳で編集 | 不要 |
| 3 | IISサイト・アプリケーションプールの作成、Windows認証の有効化、`data/`への権限付与 | **必要** |
| 4 | タスクスケジューラへ実行エンジンを登録 | **必要** |
| 5 | 上記1〜4を順に実行 | 3・4の実行時に必要 |

3・4を選ぶ場合は、`setup.bat`自体を「管理者として実行」で起動しておくこと
（右クリック › 管理者として実行）。管理者権限がない状態で3・4を選ぶとエラーになる。

`3`・`4`は内部で`scripts\setup-iis.ps1`・`scripts\register-task.ps1`をそれぞれ呼び出している。
単体で再実行したい場合はこれらのPowerShellスクリプトを直接叩いてもよい。

```powershell
# 例: ポート8080でIISサイトを作り直す
powershell -ExecutionPolicy Bypass -File scripts\setup-iis.ps1 -Port 8080

# 例: 実行ユーザーや間隔を変えて登録し直す
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -TaskUser "DOMAIN\svc-devloop" -IntervalMinutes 15
```

## 4. IISサイト構築（`scripts/setup-iis.ps1`）が行うこと

- アプリケーションプール`DevLoopAppPool`を作成（マネージドコードなし・常時実行）
- サイト`DevLoopWebApp`を`webapp/`フォルダを物理パスとして作成
- サイト単位でWindows認証を有効化・匿名認証を無効化
- `data/`フォルダに、このアプリケーションプールのID（`IIS AppPool\DevLoopAppPool`）への
  読み書き権限を付与

`webapp/web.config`（リポジトリに同梱済み）が実際のリクエスト処理を担う。

- `dist/server.js`をiisnodeのハンドラーとして登録
- すべてのパスを`dist/server.js`へ内部リライト
- **WebDAVモジュールを無効化**（有効なままだとPUT/DELETEを本アプリより先に横取りし、
  チケットの並べ替え・削除APIが失敗する）
- IISが認証したWindowsアカウント名（`LOGON_USER`）を`X-Remote-User`ヘッダーへ書き込む
  （クライアントが同名ヘッダーを自称しても、この処理で必ず上書きされる）

## 5. タスクスケジューラ登録（`scripts/register-task.ps1`）が行うこと

- 指定した間隔（既定30分）で`node engine\dist\run.js`を実行するタスクを作成
- 実行ユーザー・パスワードの入力を求める（前提: 2章の「実行エンジン専用ユーザー」）
- `MultipleInstances = IgnoreNew` を設定し、前回の実行が終わっていない間は
  タスクスケジューラ自身が次回起動をスキップする
  （実行エンジン内部の多重起動防止と合わせた二重の安全策）

## 6. 動作確認チェックリスト

上から順に確認する。

1. `http://localhost:<ポート番号>/` にブラウザでアクセスし、キュー画面が表示される
2. 同じ画面で `/api/whoami` を開き、`{"user":"ドメイン\\自分のアカウント名"}` が返る
   （返らない・匿名になる場合は4章のWindows認証設定を再確認）
3. 画面からテスト用のRedmineチケット番号を1件登録できる
4. タスクスケジューラの「タスクスケジューラライブラリ」で`DevLoopEngine`タスクを
   右クリック › 実行 し、`data\logs\<チケットID>.jsonl` にログが追記される
5. 対象Gitリポジトリに `ticket/<番号>` ブランチが作成され、
   （AIが変更を作った場合は）リモートにプッシュされる
6. Redmineの当該チケットにコメントが登録される
7. 画面の「キューを一時停止する」「強制中断」がそれぞれ効く

## 7. トラブルシューティング

| 症状 | 原因の見当 | 対処 |
|---|---|---|
| サイトにアクセスすると401 | Windows認証が正しく有効化されていない、ブラウザ側がWindows統合認証を許可していない | IISマネージャーでサイトの「認証」を確認。ブラウザはイントラネットゾーンとして認識されているか確認 |
| `/api/whoami`が空、または常に同じユーザーになる | `web.config`のリライトルールが適用されていない（URL Rewriteモジュール未導入等） | IISマネージャーでサイトを選び「URL 書き換え」アイコンが表示されるか確認 |
| PUT/DELETEのAPIだけ失敗する | WebDAV Publishingが有効なまま | `web.config`のWebDAVModule除去設定を確認。サーバー全体でWebDAV機能自体を無効化してもよい |
| サイトにアクセスすると502/500 | iisnode未導入、またはNode.jsのパスが変わった | iisnodeを導入、`web.config`の`nodeProcessCommandLine`を確認 |
| タスクを実行してもチケットが進まない | `config/config.json`未編集、実行ユーザーでCopilot CLI/Gitの認証情報が未設定 | 2章の「実行エンジン専用ユーザーの準備」をそのユーザーで再確認 |
| タスクが「0x1」等で失敗する | 実行ユーザーのパスワード変更、アカウントロック | `register-task.ps1`を再実行してパスワードを入力し直す |

## 8. やり直す・削除する場合

```powershell
# IISサイト・アプリケーションプールの削除
Remove-Website -Name "DevLoopWebApp"
Remove-WebAppPool -Name "DevLoopAppPool"

# タスクの削除
Unregister-ScheduledTask -TaskName "DevLoopEngine" -Confirm:$false
```

`data/`フォルダを削除するとキュー・設定・ログがすべて初期化される
（`config/config.json`は削除されない）。
