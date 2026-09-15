# シーケンス図

## 1. チケット登録
```mermaid
sequenceDiagram
    actor U as 利用者
    participant W as Web管理アプリ
    participant R as Redmine
    participant Q as queue.json

    U->>W: チケット番号・AIモデルを指定して登録
    W->>R: チケット存在確認・件名取得
    R-->>W: 件名
    W->>Q: ロック取得
    W->>Q: 末尾に追加（status=waiting, title保存, orderIndex採番）
    W->>Q: ロック解放
    W-->>U: 登録完了・一覧に反映
```

## 2. 正常系（実装→レビューPASS→プッシュ）
```mermaid
sequenceDiagram
    participant S as タスクスケジューラ
    participant E as 実行エンジン
    participant Q as queue.json
    participant R as Redmine
    participant G as Gitリポジトリ
    participant CI as Copilot CLI(実装AI)
    participant CR as Copilot CLI(レビューAI)
    participant L as logs/{ID}.jsonl

    S->>E: 30分間隔で起動
    E->>Q: ロック取得・runner/queuePausedを確認
    Q-->>E: 実行中なし・先頭チケットあり
    E->>G: 作業ツリーがクリーンか確認（汚れていればWIP退避）
    E->>Q: status=running、runnerにPID・時刻をセット・ロック解放
    E->>E: 監視タイマー開始（30秒毎ハートビート/5秒毎に中断要求確認）
    E->>R: チケット情報取得(GET /issues/{no}.json)
    R-->>E: タイトル・説明・ステータス
    E->>G: ベースブランチを最新化し ticket/{no} を作成
    E->>CI: 実装を指示（タイムアウト30分）
    CI-->>E: 実装結果（差分）
    E->>L: 実装ログを追記
    E->>CR: 差分をレビュー依頼（タイムアウト10分）
    CR-->>E: RESULT: PASS
    E->>L: レビューログを追記
    E->>G: git add -A → commit → push
    E->>R: 完了コメント（ブランチ名・PR作成の案内）を登録
    E->>E: 監視タイマー停止
    E->>Q: ロック取得しstatus=pushed・runnerクリア・ロック解放
```

## 3. レビューNG→差し戻し再実装（上限内）
```mermaid
sequenceDiagram
    participant E as 実行エンジン
    participant CI as Copilot CLI(実装AI)
    participant CR as Copilot CLI(レビューAI)
    participant Q as queue.json
    participant L as logs/{ID}.jsonl

    E->>CI: 実装を指示
    CI-->>E: 実装結果（差分）
    E->>CR: 差分をレビュー依頼
    CR-->>E: RESULT: FAIL（指摘内容）
    E->>L: レビューNGログを追記
    E->>Q: retryCount + 1（上限未満）
    E->>CI: 指摘内容を渡し再実装を指示
    CI-->>E: 修正後の差分
    E->>CR: 再レビュー依頼
    CR-->>E: RESULT: PASS
    Note over E: 以降は正常系と同じ（コミット・プッシュ・コメント登録）
```

## 4. 再実装ループが上限到達
```mermaid
sequenceDiagram
    participant E as 実行エンジン
    participant CR as Copilot CLI(レビューAI)
    participant Q as queue.json
    participant G as Gitリポジトリ
    participant R as Redmine
    participant L as logs/{ID}.jsonl

    CR-->>E: RESULT: FAIL（3回目）
    E->>Q: retryCount が retryLimit(3) に到達
    E->>G: WIPコミットで退避（[WIP] #1234 件名）
    E->>R: 「要確認（人対応）」コメントを登録
    E->>Q: status=needs_human・runnerクリア（キュー対象から除外）
    E->>L: 上限到達ログを追記
    Note over E,G: 作業内容はWIPコミットとしてブランチに残る
```

## 5. タイムアウト（Copilot CLIが応答しない）
```mermaid
sequenceDiagram
    participant E as 実行エンジン
    participant T as 監視タイマー
    participant CI as Copilot CLI
    participant G as Gitリポジトリ
    participant Q as queue.json
    participant R as Redmine

    E->>CI: 実装を指示（タイムアウト30分）
    T->>T: 経過時間が implTimeoutMinutes を超過
    T->>CI: プロセスをkill
    E->>G: WIPコミットで退避
    E->>R: 「タイムアウトにより中断。要確認」コメントを登録
    E->>Q: status=needs_human・runnerクリア
```

## 6. Web画面からの強制中断（即時）
```mermaid
sequenceDiagram
    actor U as 利用者
    participant W as Web管理アプリ
    participant Q as queue.json
    participant T as 監視タイマー(実行エンジン内)
    participant CI as Copilot CLI
    participant G as Gitリポジトリ

    U->>W: 実行中チケットの強制中断ボタン押下
    W->>Q: abortRequestedTicketId をセット
    W-->>U: 受付（状態は「中断要求中」表示）
    loop 5秒間隔
        T->>Q: abortRequestedTicketId を確認
    end
    Q-->>T: 中断対象と一致
    T->>CI: フェーズ完了を待たずプロセスをkill
    T->>G: WIPコミットで退避
    T->>Q: status=canceled・abortRequestedTicketIdクリア・runnerクリア
```

## 7. キュー一時停止中の起動
```mermaid
sequenceDiagram
    participant S as タスクスケジューラ
    participant E as 実行エンジン
    participant Q as queue.json

    S->>E: 30分間隔で起動
    E->>Q: queuePaused を確認
    Q-->>E: true（一時停止中）
    E->>E: 何もせず終了
```

## 8. 多重起動防止（前回の処理が正常に継続中）
```mermaid
sequenceDiagram
    participant S as タスクスケジューラ
    participant E2 as 実行エンジン（今回起動）
    participant Q as queue.json
    participant OS as OS(プロセス一覧)

    S->>E2: 30分間隔で起動
    E2->>Q: runner を確認
    Q-->>E2: ticketId=2, pid=1234, heartbeatAt=1分前
    E2->>OS: pid 1234 の生存確認
    OS-->>E2: 生存中
    E2->>E2: 正常に実行中と判断し、何もせず終了
```

## 9. 異常終了からの復旧（PC再起動・プロセス強制終了など）
```mermaid
sequenceDiagram
    participant S as タスクスケジューラ
    participant E as 実行エンジン（今回起動）
    participant Q as queue.json
    participant OS as OS(プロセス一覧)
    participant G as Gitリポジトリ
    participant R as Redmine

    S->>E: 30分間隔で起動
    E->>Q: runner を確認
    Q-->>E: ticketId=2, pid=1234, heartbeatAt=40分前
    E->>OS: pid 1234 の生存確認
    OS-->>E: 存在しない（またはハートビートが閾値超過）
    E->>E: 前回実行が異常終了したと判断
    E->>G: 残った未コミット変更をWIPコミットで退避
    E->>R: 「実行エンジンの異常終了により中断。要確認」コメントを登録
    E->>Q: 対象チケットを status=needs_human・runnerクリア
    Note over E: 同じ起動では次のチケットに着手せず終了
```
