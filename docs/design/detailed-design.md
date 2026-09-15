# 詳細設計書：Redmine連携 自動開発ループ

前提：`docs/requirements/requirements.md` の要件定義に基づく詳細設計。
要件定義で「未確定」としていた項目は、本書内で決定・提案する（11章に一覧）。

## 1. システム構成
| コンポーネント | 役割 | 技術（提案） |
|---|---|---|
| Web管理アプリ | キュー管理画面。Windows認証でアクセス制御 | Node.js + TypeScript + Express、IIS + iisnodeでホストしIISのWindows認証機能を利用 |
| DB | キュー・ログ・設定を保持 | SQLite（1ファイル、Web管理アプリと実行エンジンで共有） |
| 実行エンジン | タスクスケジューラから起動されるバッチ処理本体 | Node.js + TypeScript（CLIスクリプト） |
| Copilot CLI呼び出し | 実装・レビューの実行 | child_processでGitHub Copilot CLIを起動、`--model`等でモデル指定 |
| Redmine連携 | チケット取得・コメント登録 | Redmine REST API（axios、APIキー認証） |
| Git連携 | ブランチ作成・コミット・プッシュ | `simple-git` または直接gitコマンド呼び出し |

IIS＋Windows認証を採用する理由：Windows統合認証の実装をアプリ側に持たず、IIS標準機能に委譲できるため。IIS環境がない場合は代替として `node-expose-sspi` 等のライブラリを検討する。

## 2. ディレクトリ構成（提案）
```
repo-root/
├── docs/
│   ├── requirements/requirements.md
│   └── design/detailed-design.md
├── webapp/            # Web管理アプリ（画面+API）
│   └── src/
├── engine/             # 実行エンジン（タスクスケジューラから起動）
│   └── src/
├── shared/             # DBアクセス・型定義など共有コード
├── config/
│   └── config.example.json   # 設定ファイルの雛形（実値は.gitignore対象）
└── data/
    └── queue.sqlite3    # DB実体（.gitignore対象）
```

## 3. DB設計（SQLite）

### tickets（キュー）
| カラム | 型 | 説明 |
|---|---|---|
| id | INTEGER PK | 内部ID |
| redmine_ticket_no | TEXT | Redmineチケット番号 |
| status | TEXT | waiting / running / needs_human / pushed / canceled |
| order_index | INTEGER | 実行順序（並べ替え対象） |
| impl_model | TEXT NULL | 実装用AIモデル（NULLならデフォルト使用） |
| review_model | TEXT NULL | レビュー用AIモデル（NULLならデフォルト使用） |
| retry_count | INTEGER | 差し戻し再実装の実施回数 |
| registered_by | TEXT | 登録したWindows認証ユーザー名 |
| registered_at | DATETIME | 登録日時 |
| started_at / finished_at | DATETIME NULL | 実行開始・終了日時 |
| branch_name | TEXT NULL | 作成したブランチ名 |
| last_error | TEXT NULL | 直近のエラー内容 |

### execution_logs（実行ログ）
| カラム | 型 | 説明 |
|---|---|---|
| id | INTEGER PK | |
| ticket_id | INTEGER FK | tickets.id |
| phase | TEXT | implement / review / retry / push / error / abort |
| content | TEXT | AI出力やシステムメッセージ |
| created_at | DATETIME | |

### settings（キー・バリュー、デフォルト値と運用フラグ）
| key | 内容 |
|---|---|
| default_impl_model | 実装用AIモデルのデフォルト |
| default_review_model | レビュー用AIモデルのデフォルト |
| retry_limit | 再実装ループの上限回数（初期値3） |
| queue_paused | キュー全体の一時停止フラグ |
| current_running_ticket_id | 実行中チケットID（多重起動防止・強制中断対象の特定に使用） |
| abort_requested_ticket_id | 強制中断要求のあったチケットID |

Redmine接続情報（URL・APIキー）、対象リポジトリのパスはDBではなく `config/config.json`（.gitignore対象）で管理し、リポジトリに平文でコミットしない。

## 4. 画面設計
1. **キュー一覧画面（トップ）**
   - 一覧：順番／チケット番号（Redmineへのリンク）／タイトル／ステータス／実装モデル／レビューモデル／登録者／登録日時／操作
   - 並べ替え（ドラッグ&ドロップ）
   - チケット追加フォーム（チケット番号＋モデル選択、未指定はデフォルト）
   - キュー全体の一時停止／再開ボタン
   - 実行中チケットの強制中断ボタン
2. **チケット詳細／ログ画面**
   - 実行ログのタイムライン表示（実装→レビュー→差し戻し…の流れが追える形式）
3. **設定画面**
   - デフォルト実装モデル／デフォルトレビューモデル／再実装上限回数の変更
   - Redmine接続情報・対象リポジトリは設定ファイル管理のため本画面では参照表示のみ

## 5. API設計（Web管理アプリ内部API）
| メソッド | パス | 内容 |
|---|---|---|
| GET | /api/queue | キュー一覧取得 |
| POST | /api/queue | チケット追加（チケット番号／モデル指定） |
| PUT | /api/queue/:id/order | 並べ替え |
| PUT | /api/queue/:id/models | モデル変更 |
| DELETE | /api/queue/:id | 未実行チケットの削除 |
| POST | /api/queue/:id/abort | 実行中チケットの強制中断要求 |
| GET | /api/queue/:id/logs | ログ取得 |
| POST | /api/queue/pause , /resume | キュー全体の一時停止／再開 |
| GET・PUT | /api/settings | デフォルト値等の取得・更新 |
| GET | /api/whoami | ログイン中のWindows認証ユーザー確認 |

## 6. 実行エンジンの処理フロー
1. タスクスケジューラから起動。DBの`current_running_ticket_id`等でロックを確認し、既に実行中なら即終了（多重起動防止）。
2. `queue_paused`がtrueなら終了。
3. `status = waiting`かつ`order_index`最小のチケットを1件取得。なければ終了。
4. チケットを`status = running`に更新し、ロックを取得。
5. Redmine APIでチケット情報（タイトル・説明・ステータス）を取得。取得失敗時は`waiting`に戻しエラーログを残し終了。
6. 対象リポジトリでmainを最新化し、ブランチ`ticket/{チケット番号}`を作成（既存なら再利用）。
7. **実装フェーズ**：実装用AIモデルでCopilot CLIを起動し、チケット内容をもとに実装させる。
8. **レビューフェーズ**：レビュー用AIモデルでCopilot CLIを起動し、差分をレビューさせる。判定はAIの出力先頭に`RESULT: PASS`または`RESULT: FAIL`を明示させる形式でパースする。
   - FAILの場合：`retry_count`をインクリメントし、上限（`retry_limit`）未満なら指摘内容を実装AIに渡して7へ戻る。上限到達なら次へ。
9. 上限到達時：`status = needs_human`。Redmineに「要確認（人対応）」コメントを追加。ブランチは削除せず保持。キューの処理対象から外れる（＝再取得されない）。
10. PASSの場合：変更をコミット（`[#{チケット番号}] {Redmine件名}`）し、`origin`にプッシュ。Redmineに完了コメント（実施内容・ブランチ名・PR作成を促す文言）を追加。`status = pushed`。
11. いずれの場合もロックを解放し終了。1件の処理が異常終了しても、次回スケジュール起動には影響しない（例外を捕捉し`waiting`または`needs_human`に戻す）。

**強制中断**：Web画面からの中断要求（`abort_requested_ticket_id`）を実行エンジンが処理の合間に確認し、要求があればCopilot CLIプロセスを終了し`status = canceled`にしてロックを解放する。ブランチは調査用に残す。

## 7. Redmine連携仕様
- チケット取得：`GET /issues/{id}.json?key=APIKEY`
- コメント追加：`PUT /issues/{id}.json`（body: `{"issue":{"notes":"..."}}`）、ヘッダ`X-Redmine-API-Key`
- 接続情報は`config/config.json`の`redmine.url` / `redmine.apiKey`で管理（.gitignore対象）
- 完了ステータスへの変更は行わない（人が手動対応、要件定義どおり）

## 8. Git連携仕様
- 対象リポジトリパスは`config.json`の`git.repoPath`で固定
- ブランチ命名規則：`ticket/{チケット番号}`（例：`ticket/1234`）
- コミットメッセージ規約：`[#{チケット番号}] {Redmine件名}`（本文にAI実装概要を追記）
- プッシュ先：`origin`。Git認証情報自体（Credential Manager等）は実行環境の前提とし本設計のスコープ外とする

## 9. AIモデル呼び出し仕様
- GitHub Copilot CLIをchild_processで起動し、`--model`オプション等でモデルを指定（実際のCLIオプション名は導入時に確認・調整）
- 実装用・レビュー用それぞれにプロンプトテンプレートを用意し、チケットのタイトル・説明・（差し戻し時は）レビュー指摘内容を埋め込む
- レビューAIには判定結果を`RESULT: PASS` / `RESULT: FAIL`の形式で明示させ、パース処理を簡素化する

## 10. 非機能設計
- **排他制御**：DB上の実行中フラグ＋PIDチェックで多重起動を防止
- **異常系**：フェーズ毎にtry/catchし、一時的エラーは`waiting`に戻す、繰り返し失敗は`needs_human`に倒す
- **ログ**：`execution_logs`に実装・レビュー・差し戻し・エラー・中断の全履歴を記録し、Web画面から閲覧可能にする
- **セキュリティ**：Redmine APIキー・Git資格情報は設定ファイル（.gitignore対象）または環境変数で管理し、リポジトリにコミットしない

## 11. 未確定事項への決定・初期値（提案）
| 項目 | 決定内容 |
|---|---|
| Web管理アプリ・実行エンジンの技術スタック | Node.js + TypeScript／Express／better-sqlite3／simple-git／axios、IIS+iisnodeでホスト |
| タスクスケジューラの起動間隔 | 30分間隔（設定ファイルで変更可能） |
| 再実装ループの上限回数 | 3回（初期値、設定画面で変更可能） |
| ブランチ命名規則 | `ticket/{チケット番号}` |
| コミットメッセージ規約 | `[#{チケット番号}] {Redmine件名}` |
| Redmine上の「要確認」表現 | チケットへのコメント追加のみ。ステータス／カスタムフィールドの変更は行わない（将来拡張の余地あり） |
| 実行ログの保存期間 | 当面無期限。SQLiteに保持し、将来的に古いログの自動削除を検討 |

## 12. 実装マイルストーン（案）
1. 設定ファイル雛形・DBスキーマ作成
2. Web管理アプリ：キュー一覧のCRUD・並べ替え
3. IIS + Windows認証の統合
4. 実行エンジン：Redmine取得→ブランチ作成→実装→レビュー→差し戻しループ→プッシュ→コメント登録
5. 強制中断・一時停止の一連動作確認
6. Windowsタスクスケジューラへの登録手順のドキュメント化
