# 詳細設計書：Redmine連携 自動開発ループ（全体概要）

前提：`docs/requirements/requirements.md` の要件定義に基づく詳細設計。
要件定義で「未確定」としていた項目は、本書内で決定・提案する（9章に一覧）。

目的別に以下のドキュメントへ分割している。本書は全体概要・実行環境の前提・データ設計・連携仕様・非機能設計をまとめる。

| ドキュメント | 内容 |
|---|---|
| `architecture.md` | システム構成図・コンポーネント一覧・ディレクトリ構成 |
| `sequence.md` | シーケンス図（正常系／差し戻し／上限到達／タイムアウト／強制中断／異常終了からの復旧等） |
| `screen-spec.md` | 画面仕様（キュー/履歴一覧・チケット詳細/ログ・設定の3画面） |
| `api-design.md` | API設計書（Web管理アプリの内部APIのリクエスト/レスポンス仕様） |

## 1. システム構成
技術スタックの概要は以下。詳細な構成図・コンポーネント一覧・ディレクトリ構成は`architecture.md`を参照。

| コンポーネント | 技術（提案） |
|---|---|
| Web管理アプリ | Node.js + TypeScript + Express、IIS + iisnodeでホストしIISのWindows認証機能を利用 |
| 実行エンジン | Node.js + TypeScript（CLIスクリプト、タスクスケジューラから起動） |
| データ管理 | **DBは使用せずJSONファイルで管理**（`queue.json` / `settings.json` / `logs/{id}.jsonl`。詳細は3章） |
| Copilot CLI呼び出し | child_processでGitHub Copilot CLIを起動、`--model`等でモデル指定 |
| Redmine連携 | Redmine REST API（axios、APIキー認証） |
| Git連携 | `simple-git` または直接gitコマンド呼び出し |

## 2. 実行環境の前提（無人実行の成立条件）
本仕組みは完全無人で動作するため、以下を**構築時の前提条件**として満たす必要がある。

### 2.1 専用実行ユーザー
- 実行エンジン専用のWindowsユーザー（以下「実行ユーザー」）を1つ用意し、タスクスケジューラのタスクはこのユーザーで実行する（「ユーザーがログオンしているかどうかにかかわらず実行する」設定＋パスワード保存）。
- **Copilot CLIとGitの認証情報は、実行ユーザーのプロファイルに保存されている必要がある。** 構築時に一度、実行ユーザーで対話的にログインを済ませておく。
  - GitHub Copilot CLIのログイン（`gh auth login`等）
  - Git Credential Manager等へのプッシュ用資格情報の保存
- 対象Gitリポジトリのローカルクローンは、実行ユーザーが読み書きできる場所に配置する。

### 2.2 Web管理アプリ側の権限
- IISのアプリケーションプールIDに、`data/`配下（`queue.json`・`settings.json`・`logs/`）の読み書き権限を付与する。
- Web管理アプリと実行エンジンは別ユーザーで動作しうるため、両者が同じJSONファイルを更新できる権限設計とする。

### 2.3 Copilot CLIの無人起動
- 対話プロンプトが出ない非対話モードで起動し、ファイル編集の承認を自動化するオプションを指定する（実際のオプション名はCLIのバージョンに合わせて導入時に確定する）。
- 応答が返らないケースに備え、フェーズ毎にタイムアウトを設ける（6章）。

## 3. データ設計（JSONファイル、DB不使用）
利用規模（チケット数は数件〜数十件、同時実行は常に1件）を踏まえ、SQLite等のDBは使わずJSONファイルで管理する。
Web管理アプリ（常駐プロセス）と実行エンジン（都度起動プロセス）が同じファイルを読み書きするため、
更新時は`proper-lockfile`等でファイル単位のロックを取得し、読み込み→更新→書き込み→ロック解放の間の競合を防ぐ。
書き込みは一時ファイルに書いてからrenameする方式でアトミック性を確保する。
複数ファイルを同時に更新する場合のロック取得順は `queue.json` → `settings.json` に統一し、デッドロックを避ける。

### data/queue.json（キュー本体・実行状態）
```json
{
  "nextId": 3,
  "queuePaused": false,
  "runner": {
    "ticketId": null,
    "pid": null,
    "heartbeatAt": null
  },
  "abortRequestedTicketId": null,
  "items": [
    {
      "id": 1,
      "redmineTicketNo": "1234",
      "title": "○○機能の追加",
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
| title | 登録時にRedmineから取得して保存する件名のキャッシュ。実行時に再取得して更新する。一覧表示はキャッシュのみ参照するため、Redmine停止中でも画面は開ける |
| orderIndex | 0始まりの連番。追加時は末尾、削除・並べ替え後は0からの連番に振り直す |
| implModel / reviewModel | `null`の場合は`settings.json`のデフォルト値を使用 |
| retryCount | 差し戻し再実装の実施回数（`settings.json`の`retryLimit`と比較） |
| runner.ticketId / pid / heartbeatAt | 実行中のチケットID・実行エンジンのプロセスID・最終ハートビート時刻。多重起動防止と異常終了検知に使用（詳細は4章） |
| abortRequestedTicketId | Web画面からの強制中断要求を保持 |

### data/settings.json（デフォルト値・設定）
```json
{
  "defaultImplModel": "gpt-4o",
  "defaultReviewModel": "gpt-4o",
  "retryLimit": 3,
  "implTimeoutMinutes": 30,
  "reviewTimeoutMinutes": 10
}
```

### data/logs/{チケットID}.jsonl（実行ログ、チケット単位・1行1エントリ）
```
{"phase":"implement","content":"実装AIによる差分作成を開始…","createdAt":"2026-09-15T18:05:01+09:00"}
{"phase":"review","content":"RESULT: FAIL - ○○の考慮漏れがあります","createdAt":"2026-09-15T18:07:30+09:00"}
```
`phase`：`implement` / `review` / `retry` / `push` / `error` / `timeout` / `abort` / `recover`。
JSON配列ではなくJSON Lines形式とし、追記のみで書き込めるようにする（ログが増えても全体の読み書きが発生しない）。
チケットごとにファイルを分けることで、キュー本体（`queue.json`）を軽量に保つ。

### config/config.json（接続情報・環境依存値、.gitignore対象）
```json
{
  "redmine": { "url": "https://redmine.example.com", "apiKey": "xxxxx" },
  "git": { "repoPath": "C:\\repos\\target-app", "baseBranch": "main", "remote": "origin" },
  "copilot": { "command": "copilot", "extraArgs": [] },
  "runner": { "staleThresholdMinutes": 5, "heartbeatIntervalSeconds": 30, "abortPollIntervalSeconds": 5 }
}
```
Redmine APIキーやリポジトリパス等の環境依存値は`data/`配下ではなく本ファイルで管理し、リポジトリに平文でコミットしない。

## 4. 多重起動防止と異常終了からの復旧
実行エンジンは1回の起動につき1チケットのみ処理する。処理は30分以上かかることがあり、
次のスケジュール起動と重なるため、以下の方式で多重起動を防止する。

- 実行エンジンは処理開始時に`runner`へ自身のPIDと現在時刻をセットし、以降30秒間隔で`heartbeatAt`を更新する。
- 次回起動時、`runner.ticketId`がセットされていれば以下を確認する。
  - `runner.pid`のプロセスが生存し、かつ`heartbeatAt`が`staleThresholdMinutes`（既定5分）以内 → **正常に実行中**と判断し、何もせず終了する。
  - プロセスが存在しない、または`heartbeatAt`が閾値を超過 → **前回の実行が異常終了した**と判断し、復旧処理を行う。

**復旧処理**：作業ツリーに残った未コミット変更をWIPコミットで退避（5章）し、対象チケットを`needs_human`に更新、`lastError`に異常終了の旨を記録、Redmineへ「実行エンジンの異常終了により中断。要確認」コメントを登録し、`runner`をクリアする。その後、同じ起動の中で次のチケットには着手せず終了する（原因不明のまま連続実行しない）。

## 5. 作業ツリーの扱い（WIPコミットによる退避）
コミットはレビューPASS後に行うため、それ以外の終了経路では未コミットの変更が作業ツリーに残る。
放置すると次のチケット処理でベースブランチの最新化・ブランチ作成が失敗するため、
**中断・上限到達・タイムアウト・異常終了の各経路で、未コミット変更を必ずWIPコミットとして退避する。**

- コミットメッセージ：`[WIP] #{チケット番号} {Redmine件名}`（退避理由を本文に記載）
- 退避先：そのチケットの作業ブランチ（`ticket/{チケット番号}`）。プッシュはしない。
- 各チケットの処理開始時にも作業ツリーの状態を確認し、クリーンでなければ退避してから着手する（保険）。
- これにより作業ツリーは常にクリーンに保たれ、かつ調査用の変更内容も失われない。

## 6. タイムアウト
Copilot CLIが応答しない場合に`running`のまま固着するのを防ぐため、フェーズ毎にタイムアウトを設ける。

| フェーズ | 設定項目 | 初期値 |
|---|---|---|
| 実装 | `implTimeoutMinutes` | 30分 |
| レビュー | `reviewTimeoutMinutes` | 10分 |

タイムアウト時は子プロセスをkillし、WIPコミットで退避したうえで`needs_human`とし、Redmineへタイムアウトした旨をコメントする。

## 7. 実行エンジンの処理フロー（概要）
詳細なやり取りは`sequence.md`を参照。処理の要点は以下。

1. タスクスケジューラから起動。`queue.json`のロックを取得し、`runner`の状態を確認する。
   - 正常に実行中 → 何もせず終了（多重起動防止）
   - 異常終了を検知 → 復旧処理（4章）を行い終了
2. `queuePaused`がtrueなら終了。
3. `status = waiting`かつ`orderIndex`最小のチケットを1件取得。なければ終了。
4. 作業ツリーがクリーンでなければWIPコミットで退避する。
5. チケットを`status = running`に、`runner`に自PID・現在時刻をセットし、ロックを解放。
6. 監視タイマーを開始する（`heartbeatIntervalSeconds`毎にハートビート更新、`abortPollIntervalSeconds`毎に強制中断要求を確認）。
7. Redmine APIでチケット情報を取得し`title`を更新。失敗時は`waiting`に戻しエラーログを残し終了。
8. ベースブランチ（`git.baseBranch`）を最新化し、ブランチ`ticket/{チケット番号}`を作成（既存なら再利用）。
9. 実装用AIモデルでCopilot CLIを起動し実装させる（`implTimeoutMinutes`でタイムアウト）。
10. レビュー用AIモデルでCopilot CLIを起動しレビューさせる（`reviewTimeoutMinutes`でタイムアウト、`RESULT: PASS` / `RESULT: FAIL`形式で判定）。
    - FAILなら`retryCount`をインクリメントし、上限未満なら指摘内容を渡して9へ戻る。上限到達なら11へ。
11. 上限到達：WIPコミットで退避し`status = needs_human`。Redmineに「要確認（人対応）」コメントを追加。キュー対象から除外。
12. PASSの場合：`git add -A`（対象リポジトリの`.gitignore`に従う）でコミットし、`origin`へプッシュ。Redmineに完了コメントを追加し`status = pushed`。
13. 監視タイマーを停止し、`runner`をクリアしてロックを解放。1件の処理が異常終了しても、次回スケジュール起動には影響しない。

**強制中断**：Web画面からの中断要求は監視タイマー（既定5秒間隔）で検知し、フェーズの完了を待たずに実行中のCopilot CLIプロセスを即座にkillする。その後WIPコミットで退避し`status = canceled`、`abortRequestedTicketId`をクリアする。

**`needs_human`チケットの再投入**：人が内容を確認・修正したうえで、再度AIに任せる場合は同じチケット番号で新規登録する（`retryCount`は0から開始）。重複チェックは`waiting`/`running`のみを対象とするため、`needs_human`のチケットと同じ番号でも登録できる。

## 8. Redmine連携仕様
- チケット取得：`GET /issues/{id}.json`（ヘッダ`X-Redmine-API-Key`）
- コメント追加：`PUT /issues/{id}.json`（body: `{"issue":{"notes":"..."}}`）
- 接続情報は`config/config.json`の`redmine.url` / `redmine.apiKey`で管理（.gitignore対象）
- コメントを登録する場面：完了（プッシュ済み）／上限到達（要確認）／タイムアウト／異常終了による中断
- 完了ステータスへの変更は行わない（人が手動対応、要件定義どおり）

## 9. Git連携仕様
- 対象リポジトリパスは`config.json`の`git.repoPath`で固定、ベースブランチは`git.baseBranch`（既定`main`）で指定
- ブランチ命名規則：`ticket/{チケット番号}`（例：`ticket/1234`）
- コミットメッセージ規約：`[#{チケット番号}] {Redmine件名}`（本文にAI実装概要を追記）。退避時は`[WIP] #{チケット番号} {Redmine件名}`
- ステージ範囲：`git add -A`。ビルド生成物等は対象リポジトリの`.gitignore`で除外されている前提とする
- プッシュ先：`config.json`の`git.remote`（既定`origin`）。Git認証情報は実行ユーザーのプロファイルに保存済みであることを前提とする（2章）

## 10. AIモデル呼び出し仕様
- GitHub Copilot CLIをchild_processで起動し、`--model`オプション等でモデルを指定（実際のCLIオプション名は導入時に確認・調整）
- 実装用・レビュー用それぞれにプロンプトテンプレートを用意し、チケットのタイトル・説明・（差し戻し時は）レビュー指摘内容を埋め込む
- レビューAIには判定結果を`RESULT: PASS` / `RESULT: FAIL`の形式で明示させ、パース処理を簡素化する
- 判定行が見つからない場合はFAIL扱いとし、指摘内容として出力全文を実装AIへ渡す

## 11. 未確定事項への決定・初期値（提案）
| 項目 | 決定内容 |
|---|---|
| Web管理アプリ・実行エンジンの技術スタック | Node.js + TypeScript／Express／JSONファイル（DB不使用）／simple-git／axios、IIS+iisnodeでホスト |
| タスクスケジューラの起動間隔 | 30分間隔（1起動につき1チケットを処理） |
| 再実装ループの上限回数 | 3回（初期値、設定画面で変更可能） |
| 実装フェーズのタイムアウト | 30分（設定画面で変更可能） |
| レビューフェーズのタイムアウト | 10分（設定画面で変更可能） |
| 異常終了の判定閾値 | ハートビート30秒間隔、5分間更新がなければ異常終了とみなす |
| ブランチ命名規則 | `ticket/{チケット番号}`（退避時のコミットは`[WIP] #{番号} {件名}`） |
| コミットメッセージ規約 | `[#{チケット番号}] {Redmine件名}` |
| Redmine上の「要確認」表現 | チケットへのコメント追加のみ。ステータス／カスタムフィールドの変更は行わない（将来拡張の余地あり） |
| 実行ログの保存期間 | 当面無期限。`logs/{id}.jsonl`に保持し、将来的に古いログの自動削除を検討 |

## 12. 非機能設計
- **排他制御**：`queue.json`更新時にファイルロック（`proper-lockfile`等）を取得し、Web管理アプリと実行エンジンの同時書き込みによる不整合を防止する。実行エンジンの多重起動防止・異常終了検知は`runner`のPIDとハートビートで判定する（4章）。
- **異常系**：フェーズ毎にtry/catchし、一時的エラー（Redmine接続失敗等）は`waiting`に戻して次回起動で再試行、タイムアウト・上限到達・異常終了は`needs_human`に倒す。いずれの経路でもWIPコミットで作業ツリーを退避する。
- **ログ**：`logs/{id}.jsonl`に実装・レビュー・差し戻し・エラー・タイムアウト・中断・復旧の全履歴を記録し、Web画面から閲覧可能にする。
- **セキュリティ**：Redmine APIキー・Git資格情報は設定ファイル（.gitignore対象）または実行ユーザーのプロファイルで管理し、リポジトリにコミットしない。Web画面はLAN内公開＋Windows統合認証とし、操作権限は利用者間で区別しない（誰でも全チケットを操作できる）。

## 13. 実装マイルストーン（案）
1. 設定ファイル雛形・JSONデータ構造（`queue.json`/`settings.json`/`logs/`）の初期化処理作成
2. Web管理アプリ：キュー/履歴一覧のCRUD・並べ替え（`api-design.md`準拠）
3. IIS + Windows認証の統合、実行ユーザーの準備（Copilot CLI・Gitの認証情報保存）
4. 実行エンジン：Redmine取得→ブランチ作成→実装→レビュー→差し戻しループ→プッシュ→コメント登録
5. 多重起動防止・異常終了からの復旧・タイムアウト・強制中断・WIP退避の動作確認
6. Windowsタスクスケジューラへの登録手順のドキュメント化
