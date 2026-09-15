# 詳細設計書：Redmine連携 自動開発ループ（全体概要）

前提：`docs/requirements/requirements.md` の要件定義に基づく詳細設計。
要件定義で「未確定」としていた項目は、本書内で決定・提案する（7章に一覧）。

目的別に以下のドキュメントへ分割している。本書は全体概要・データ設計・連携仕様・非機能設計をまとめる。

| ドキュメント | 内容 |
|---|---|
| `architecture.md` | システム構成図・コンポーネント一覧・ディレクトリ構成 |
| `sequence.md` | シーケンス図（正常系／差し戻し／上限到達／強制中断／多重起動防止等） |
| `screen-spec.md` | 画面仕様（キュー一覧・チケット詳細/ログ・設定の3画面） |
| `api-design.md` | API設計書（Web管理アプリの内部APIのリクエスト/レスポンス仕様） |

## 1. システム構成
技術スタックの概要は以下。詳細な構成図・コンポーネント一覧・ディレクトリ構成は`architecture.md`を参照。

| コンポーネント | 技術（提案） |
|---|---|
| Web管理アプリ | Node.js + TypeScript + Express、IIS + iisnodeでホストしIISのWindows認証機能を利用 |
| 実行エンジン | Node.js + TypeScript（CLIスクリプト、タスクスケジューラから起動） |
| データ管理 | **DBは使用せずJSONファイルで管理**（`queue.json` / `settings.json` / `logs/{id}.json`。詳細は2章） |
| Copilot CLI呼び出し | child_processでGitHub Copilot CLIを起動、`--model`等でモデル指定 |
| Redmine連携 | Redmine REST API（axios、APIキー認証） |
| Git連携 | `simple-git` または直接gitコマンド呼び出し |

## 2. データ設計（JSONファイル、DB不使用）
利用規模（チケット数は数件〜数十件、同時実行は常に1件）を踏まえ、SQLite等のDBは使わずJSONファイルで管理する。
Web管理アプリ（常駐プロセス）と実行エンジン（都度起動プロセス）が同じファイルを読み書きするため、
更新時は`proper-lockfile`等でファイル単位のロックを取得し、読み込み→更新→書き込み→ロック解放の間の競合を防ぐ。
書き込みは一時ファイルに書いてからrenameする方式でアトミック性を確保する。

### data/queue.json（キュー本体・実行状態）
```json
{
  "nextId": 3,
  "queuePaused": false,
  "currentRunningTicketId": null,
  "abortRequestedTicketId": null,
  "items": [
    {
      "id": 1,
      "redmineTicketNo": "1234",
      "status": "waiting",
      "orderIndex": 0,
      "implModel": null,
      "reviewModel": null,
      "retryCount": 0,
      "registeredBy": "DOMAIN\\sato",
      "registeredAt": "2026-09-15T18:00:00+09:00",
      "startedAt": null,
      "finishedAt": null,
      "branchName": null,
      "lastError": null
    }
  ]
}
```
| フィールド | 説明 |
|---|---|
| status | `waiting` / `running` / `needs_human` / `pushed` / `canceled` |
| implModel / reviewModel | `null`の場合は`settings.json`のデフォルト値を使用 |
| retryCount | 差し戻し再実装の実施回数（`settings.json`の`retryLimit`と比較） |
| currentRunningTicketId | 実行エンジンの多重起動防止・強制中断対象の特定に使用 |
| abortRequestedTicketId | Web画面からの強制中断要求を保持 |

### data/settings.json（デフォルト値・設定）
```json
{
  "defaultImplModel": "gpt-4o",
  "defaultReviewModel": "gpt-4o",
  "retryLimit": 3
}
```

### data/logs/{チケットID}.json（実行ログ、チケット単位でファイルを分割）
```json
[
  { "phase": "implement", "content": "実装AIによる差分作成を開始…", "createdAt": "2026-09-15T18:05:01+09:00" },
  { "phase": "review", "content": "RESULT: FAIL - ○○の考慮漏れがあります", "createdAt": "2026-09-15T18:07:30+09:00" }
]
```
`phase`：`implement` / `review` / `retry` / `push` / `error` / `abort`。
チケットごとにファイルを分けることで、キュー本体（`queue.json`）を軽量に保ち、ログ量が増えても一覧取得への影響を避ける。

### Redmine接続情報・対象リポジトリパス
`data/`配下ではなく`config/config.json`（.gitignore対象）で管理し、リポジトリに平文でコミットしない。

## 3. 実行エンジンの処理フロー（概要）
詳細なやり取りは`sequence.md`を参照。処理の要点は以下。
1. タスクスケジューラから起動。`currentRunningTicketId`等で多重起動を確認し、実行中なら即終了。
2. `queuePaused`がtrueなら終了。
3. `status = waiting`かつ`orderIndex`最小のチケットを1件取得。なければ終了。
4. チケットを`status = running`に更新。
5. Redmine APIでチケット情報を取得。失敗時は`waiting`に戻しエラーログを残し終了。
6. 対象リポジトリでmainを最新化し、ブランチ`ticket/{チケット番号}`を作成（既存なら再利用）。
7. 実装用AIモデルでCopilot CLIを起動し実装させる。
8. レビュー用AIモデルでCopilot CLIを起動しレビューさせる（`RESULT: PASS` / `RESULT: FAIL`形式で判定）。
   - FAILなら`retryCount`をインクリメントし、上限未満なら指摘内容を渡して7へ戻る。上限到達なら9へ。
9. 上限到達：`status = needs_human`。Redmineに「要確認（人対応）」コメントを追加し、キュー対象から除外。ブランチは保持。
10. PASSの場合：コミット・プッシュし、Redmineに完了コメントを追加。`status = pushed`。
11. いずれの場合も次回スケジュール起動には影響しない（例外は捕捉し`waiting`または`needs_human`に戻す）。

**強制中断**：Web画面からの中断要求（`abortRequestedTicketId`）を処理の合間に確認し、要求があればCopilot CLIプロセスをkillし`status = canceled`にする。ブランチは調査用に保持する。

## 4. Redmine連携仕様
- チケット取得：`GET /issues/{id}.json?key=APIKEY`
- コメント追加：`PUT /issues/{id}.json`（body: `{"issue":{"notes":"..."}}`）、ヘッダ`X-Redmine-API-Key`
- 接続情報は`config/config.json`の`redmine.url` / `redmine.apiKey`で管理（.gitignore対象）
- 完了ステータスへの変更は行わない（人が手動対応、要件定義どおり）

## 5. Git連携仕様
- 対象リポジトリパスは`config.json`の`git.repoPath`で固定
- ブランチ命名規則：`ticket/{チケット番号}`（例：`ticket/1234`）
- コミットメッセージ規約：`[#{チケット番号}] {Redmine件名}`（本文にAI実装概要を追記）
- プッシュ先：`origin`。Git認証情報自体（Credential Manager等）は実行環境の前提とし本設計のスコープ外とする

## 6. AIモデル呼び出し仕様
- GitHub Copilot CLIをchild_processで起動し、`--model`オプション等でモデルを指定（実際のCLIオプション名は導入時に確認・調整）
- 実装用・レビュー用それぞれにプロンプトテンプレートを用意し、チケットのタイトル・説明・（差し戻し時は）レビュー指摘内容を埋め込む
- レビューAIには判定結果を`RESULT: PASS` / `RESULT: FAIL`の形式で明示させ、パース処理を簡素化する

## 7. 未確定事項への決定・初期値（提案）
| 項目 | 決定内容 |
|---|---|
| Web管理アプリ・実行エンジンの技術スタック | Node.js + TypeScript／Express／JSONファイル（DB不使用）／simple-git／axios、IIS+iisnodeでホスト |
| タスクスケジューラの起動間隔 | 30分間隔（設定ファイルで変更可能） |
| 再実装ループの上限回数 | 3回（初期値、設定画面で変更可能） |
| ブランチ命名規則 | `ticket/{チケット番号}` |
| コミットメッセージ規約 | `[#{チケット番号}] {Redmine件名}` |
| Redmine上の「要確認」表現 | チケットへのコメント追加のみ。ステータス／カスタムフィールドの変更は行わない（将来拡張の余地あり） |
| 実行ログの保存期間 | 当面無期限。`logs/{id}.json`に保持し、将来的に古いログの自動削除を検討 |

## 8. 非機能設計
- **排他制御**：`queue.json`更新時にファイルロック（`proper-lockfile`等）を取得し、Web管理アプリと実行エンジンの同時書き込みによる不整合を防止する。実行エンジンの多重起動防止は`currentRunningTicketId`の有無で判定する。
- **異常系**：フェーズ毎にtry/catchし、一時的エラーは`waiting`に戻す、繰り返し失敗は`needs_human`に倒す
- **ログ**：`logs/{id}.json`に実装・レビュー・差し戻し・エラー・中断の全履歴を記録し、Web画面から閲覧可能にする
- **セキュリティ**：Redmine APIキー・Git資格情報は設定ファイル（.gitignore対象）または環境変数で管理し、リポジトリにコミットしない

## 9. 実装マイルストーン（案）
1. 設定ファイル雛形・JSONデータ構造（`queue.json`/`settings.json`/`logs/`）の初期化処理作成
2. Web管理アプリ：キュー一覧のCRUD・並べ替え（`api-design.md`準拠）
3. IIS + Windows認証の統合
4. 実行エンジン：Redmine取得→ブランチ作成→実装→レビュー→差し戻しループ→プッシュ→コメント登録
5. 強制中断・一時停止の一連動作確認
6. Windowsタスクスケジューラへの登録手順のドキュメント化
