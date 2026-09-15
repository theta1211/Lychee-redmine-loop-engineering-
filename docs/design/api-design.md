# API設計書

Web管理アプリが提供する内部API。すべてIISのWindows統合認証配下で提供され、
未認証アクセスはIISが401を返すため、アプリ側での認証実装は不要。
データはDB不使用で `data/queue.json` / `data/settings.json` / `data/logs/{id}.jsonl` を直接読み書きする
（読み書き時はファイルロックを取得する。詳細は`detailed-design.md`参照）。

共通仕様：
- Content-Type: `application/json`
- エラー時のレスポンス形式：`{ "error": { "code": "STRING", "message": "人が読めるメッセージ" } }`
- 日時はISO 8601（例：`2026-09-15T18:00:00+09:00`）

## 1. GET /api/queue
キュー一覧を取得する。

**クエリパラメータ**
| 名前 | 値 | 既定 | 説明 |
|---|---|---|---|
| scope | `queue` / `history` / `all` | `queue` | `queue`＝`waiting`・`running`、`history`＝`pushed`・`needs_human`・`canceled` |

**レスポンス 200**
```json
{
  "queuePaused": false,
  "runner": {
    "ticketId": 2,
    "pid": 1234,
    "heartbeatAt": "2026-09-15T18:31:00+09:00"
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
      "lastError": null,
      "abortRequested": false
    }
  ]
}
```
- `title`は登録時にRedmineから取得して保存したキャッシュ（実行時に再取得して更新）。本APIではRedmineへ問い合わせないため、Redmine停止中でも一覧を表示できる。
- `abortRequested`は`abortRequestedTicketId`と一致する場合にtrue（画面では「中断要求中」と表示）。

## 2. POST /api/queue
チケットをキューに追加する。追加時にRedmineへ存在確認と件名取得を行う。

**リクエスト**
```json
{
  "redmineTicketNo": "1235",
  "implModel": "gpt-4o",
  "reviewModel": null
}
```
`implModel`/`reviewModel`を省略または`null`の場合はデフォルト値を使用する。
`orderIndex`は末尾に採番し、`registeredBy`はWindows認証のアカウント名を自動設定する。

**レスポンス 201**：作成されたチケットのオブジェクト（1.の`items[]`要素と同形式）

**エラー**
| code | 条件 | HTTPステータス |
|---|---|---|
| DUPLICATE_TICKET | 同一チケット番号が`waiting`/`running`で既に存在（履歴にある同番号の再登録は許可） | 409 |
| INVALID_TICKET_NO | チケット番号が空／形式不正 | 400 |
| REDMINE_NOT_FOUND | Redmine上に該当チケットが存在しない | 404 |
| REDMINE_UNAVAILABLE | Redmineへ接続できない | 503 |

## 3. PUT /api/queue/:id/order
実行順序を変更する（`waiting`状態のチケットのみ対象）。
更新後、`waiting`のチケットの`orderIndex`を0からの連番に振り直す。

**リクエスト**
```json
{ "newIndex": 0 }
```

**レスポンス 200**：更新後のキュー一覧（1.と同形式）

**エラー**
| code | 条件 |
|---|---|
| TICKET_NOT_WAITING | 対象チケットが`waiting`以外の状態 |
| TICKET_NOT_FOUND | 指定idが存在しない |

## 4. PUT /api/queue/:id/models
チケットの実装AI／レビューAIモデルを変更する（`waiting`状態のみ）。

**リクエスト**
```json
{ "implModel": "claude", "reviewModel": "gpt-4o" }
```

**レスポンス 200**：更新後のチケットオブジェクト

**エラー**：`TICKET_NOT_WAITING`、`TICKET_NOT_FOUND`、`INVALID_MODEL`

## 5. DELETE /api/queue/:id
チケットを一覧から削除する。`running`以外のすべての状態（`waiting` / `pushed` / `needs_human` / `canceled`）で削除できる。
`running`のチケットは先に強制中断（6.）してから削除する。
削除時は`logs/{id}.jsonl`も併せて削除する。Gitのブランチ・Redmineのコメントは削除しない。

**レスポンス 204**：本文なし

**エラー**
| code | 条件 |
|---|---|
| TICKET_RUNNING | 対象チケットが`running`状態（中断してから削除する必要がある） |
| TICKET_NOT_FOUND | 指定idが存在しない |

## 6. POST /api/queue/:id/abort
実行中（`running`）のチケットに強制中断を要求する。実際の中断は実行エンジンの監視タイマー（既定5秒間隔）が
検知して行うため、本APIは要求フラグ（`abortRequestedTicketId`）を立てるのみで即時完了を保証しない。

**レスポンス 202**
```json
{ "accepted": true, "ticketId": 2 }
```

**エラー**：`TICKET_NOT_RUNNING`（`running`以外の状態）、`TICKET_NOT_FOUND`

## 7. GET /api/queue/:id/logs
チケットの実行ログを取得する（`data/logs/{id}.jsonl`を1行ずつ読み、配列にして返す）。

**レスポンス 200**
```json
{
  "ticketId": 2,
  "logs": [
    { "phase": "implement", "content": "実装AIによる差分作成を開始…", "createdAt": "2026-09-15T18:05:01+09:00" },
    { "phase": "review", "content": "RESULT: FAIL - ○○の考慮漏れがあります", "createdAt": "2026-09-15T18:07:30+09:00" }
  ]
}
```
`phase`の値：`implement` / `review` / `retry` / `push` / `error` / `timeout` / `abort` / `recover`

## 8. POST /api/queue/pause
キュー全体を一時停止する。実行中のチケットは中断せず、最後まで処理される。

**レスポンス 200**：`{ "queuePaused": true }`

## 9. POST /api/queue/resume
キュー全体を再開する。

**レスポンス 200**：`{ "queuePaused": false }`

## 10. GET /api/settings
現在の設定値を取得する。

**レスポンス 200**
```json
{
  "defaultImplModel": "gpt-4o",
  "defaultReviewModel": "gpt-4o",
  "retryLimit": 3,
  "implTimeoutMinutes": 30,
  "reviewTimeoutMinutes": 10,
  "reference": {
    "redmineUrl": "https://redmine.example.com",
    "targetRepoPath": "C:\\repos\\target-app",
    "baseBranch": "main"
  }
}
```
`reference`配下は`config/config.json`由来の参照表示専用項目（本APIでは編集不可）。

## 11. PUT /api/settings
設定値を更新する（`defaultImplModel` / `defaultReviewModel` / `retryLimit` / `implTimeoutMinutes` / `reviewTimeoutMinutes`のみ変更可）。
変更は保存後に開始される処理から反映され、実行中のチケットには適用しない。

**リクエスト**
```json
{
  "defaultImplModel": "claude",
  "defaultReviewModel": "gpt-4o",
  "retryLimit": 3,
  "implTimeoutMinutes": 30,
  "reviewTimeoutMinutes": 10
}
```

**レスポンス 200**：更新後の設定値（10.と同形式）

**エラー**
| code | 条件 |
|---|---|
| INVALID_RETRY_LIMIT | `retryLimit`が1以上の整数でない |
| INVALID_TIMEOUT | タイムアウト値が1以上の整数でない |
| INVALID_MODEL | GitHub Copilot CLIが対応しないモデル名を指定 |

## 12. GET /api/whoami
Windows認証で識別された現在のログインユーザー名を返す（デバッグ・画面表示用）。

**レスポンス 200**
```json
{ "user": "DOMAIN\\sato" }
```
