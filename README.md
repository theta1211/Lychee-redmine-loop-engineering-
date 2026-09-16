# Redmine連携 自動開発ループ

Redmineのチケット番号をWeb画面で指定しておくと、Windowsのタスクスケジューラが定期的に起動する
実行エンジンがGitHub Copilot CLIを使って実装・レビュー・修正を自動で行い、コミット・プッシュまで
実施する仕組み。設計の経緯・詳細は以下を参照。

- 要件定義: [`docs/requirements/requirements.md`](docs/requirements/requirements.md)
- システム構成図: [`docs/design/architecture.md`](docs/design/architecture.md)
- シーケンス図: [`docs/design/sequence.md`](docs/design/sequence.md)
- 画面仕様: [`docs/design/screen-spec.md`](docs/design/screen-spec.md)（[HTMLモック](docs/design/screen-mockup.html)あり）
- API設計書: [`docs/design/api-design.md`](docs/design/api-design.md)
- 詳細設計（データ設計・連携仕様・非機能設計）: [`docs/design/detailed-design.md`](docs/design/detailed-design.md)
- **Windows環境構築ガイド（前提ソフトウェア・自動セットアップ・動作確認・トラブルシューティング）**:
  [`docs/setup/windows-setup.md`](docs/setup/windows-setup.md)

## リポジトリ構成

```
shared/    共有ロジック（JSONファイルの読み書き・Redmine/Git/Copilot CLI連携）
webapp/    Web管理アプリ（キュー管理画面 + API、Express）
engine/    実行エンジン（タスクスケジューラから起動するCLI）
config/    設定ファイルの雛形（実際の config.json は.gitignore対象）
data/      実行時に生成されるキュー/設定/ログ（.gitignore対象、logs/.gitkeepのみ管理）
docs/      要件定義・詳細設計ドキュメント
scripts/   Windows環境構築用のPowerShellスクリプト（setup.batから呼び出される）
setup.bat  Windows向けの対話式セットアップ（依存関係インストール〜IIS〜タスク登録）
```

DBは使用せず、`data/queue.json` / `data/settings.json` / `data/logs/{チケットID}.jsonl` の
JSONファイルで状態を管理する（詳細は`docs/design/detailed-design.md`の「データ設計」を参照）。

## 前提条件

- Node.js 20以降
- 対象Gitリポジトリへの読み書き権限
- GitHub Copilot CLI（実行エンジンを動かすユーザーでログイン済みであること）
- 既存のRedmineサーバーとAPIキー

本番運用では、実行エンジンをタスクスケジューラで動かす**専用のWindowsユーザー**を用意し、
そのユーザーのプロファイルで事前にGitHub Copilot CLIのログインとGitの認証情報（Credential Manager等）を
済ませておく必要がある（詳細は`docs/design/detailed-design.md`の「実行環境の前提」を参照）。

## セットアップ

```bash
npm install
npm run build
cp config/config.example.json config/config.json
# config/config.json を環境に合わせて編集する（Redmine URL/APIキー、対象リポジトリパス等）
```

### config.json の項目

| 項目 | 説明 |
|---|---|
| `redmine.url` / `redmine.apiKey` | 既存Redmineサーバーの接続情報 |
| `git.repoPath` | 実装対象リポジトリのローカルパス（1つに固定） |
| `git.baseBranch` / `git.remote` | ベースブランチ・プッシュ先リモート名 |
| `copilot.command` / `copilot.extraArgs` | GitHub Copilot CLIの実行コマンドと追加引数 |
| `copilot.mock` | `true`にするとCopilot CLIを起動せずスタブ応答を返す（ローカル動作確認用） |
| `runner.staleThresholdMinutes` | この時間ハートビートが更新されなければ異常終了とみなす |
| `runner.heartbeatIntervalSeconds` | 実行エンジンがハートビートを更新する間隔 |
| `runner.abortPollIntervalSeconds` | 強制中断要求を確認する間隔 |
| `dataDir` | `queue.json`等を置くディレクトリ（既定は`./data`） |

## ローカルでの動作確認

Windows認証の代わりに環境変数でユーザーを指定して動かせる。

```bash
# Web管理アプリ
DEVLOOP_DEV_USER='DOMAIN\devuser' npm run start:webapp
# → http://127.0.0.1:3000 （PORT/HOST環境変数で変更可）

# 実行エンジンを1回だけ手動実行
npm run run:engine
```

`config.copilot.mock: true` にしておけば、実際のGitHub Copilot CLIがなくても
`RESULT: PASS` を返すスタブで一連の流れ（ブランチ作成〜コミット〜プッシュ〜Redmineコメント）を確認できる。

## テスト

```bash
npm test        # 全workspace（shared/webapp/engine）のvitestを実行
npm run typecheck
```

## Windows本番環境への導入

対話式の `setup.bat`（リポジトリ直下）で、依存関係のインストール〜ビルド〜
config.json作成〜IISサイト構築〜タスクスケジューラ登録までを行える。
IIS・タスクスケジューラの操作は管理者権限が必要なため、`setup.bat`を
「管理者として実行」で起動すること。

手順・前提ソフトウェア・動作確認チェックリスト・トラブルシューティングの詳細は
**[`docs/setup/windows-setup.md`](docs/setup/windows-setup.md)** を参照。

概要（`setup.bat`が内部で行うこと）:

1. `npm install && npm run build`
2. `config/config.example.json` → `config/config.json` の作成・編集
3. IISサイト（`webapp/`を物理パスとするアプリケーションプール）を作成し、
   Windows認証を有効化・匿名認証を無効化。IISが認証したアカウント名は
   `webapp/web.config`のURL RewriteルールによりX-Remote-Userヘッダーへ書き込まれる
   （クライアントが自称した同名ヘッダーは上書きされる）。Nodeプロセス自体は
   既定でループバック（127.0.0.1）のみ待ち受けるため、LANからはIIS経由でしか到達できない。
4. Windowsタスクスケジューラに、実行エンジン専用ユーザーで
   `node engine/dist/run.js` を一定間隔（既定30分）実行するタスクを登録する
   （`MultipleInstances=IgnoreNew`により前回実行中は次回起動をスキップ）。

## 未実装・今後の課題

- GitHub Copilot CLIの実際の起動方法（`shared/src/copilotRunner.ts`は`--model`＋標準入力でプロンプトを渡す想定）は、
  導入するCLIのバージョンに合わせて調整が必要。
- 画面のドラッグ&ドロップ並べ替えは、実装簡略化のため上下ボタンでの並べ替えとしている。
- `setup.bat`・`scripts/*.ps1`・`webapp/web.config`はIIS/iisnode/タスクスケジューラの
  公開仕様に基づいて作成しているが、実開発環境がLinuxのため実機（Windows）では未検証。
  導入時は`docs/setup/windows-setup.md`の動作確認チェックリストを必ず一通り確認すること。
