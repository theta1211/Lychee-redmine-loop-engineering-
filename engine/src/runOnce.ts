import {
  loadConfig,
  getQueue,
  claimNextTicket,
  updateHeartbeat,
  updateTicketTitle,
  incrementRetry,
  finishTicket,
  revertToWaiting,
  isAbortRequested,
  getSettings,
  appendLog,
  createRedmineClient,
  createGitOps,
  createCopilotRunner,
  parseReviewVerdict,
  buildImplementPrompt,
  buildReviewPrompt,
  RedmineNotFoundError,
  type AppConfig,
  type RedmineClient,
  type RedmineIssue,
  type GitOps,
  type CopilotRunner,
  type RunnerState,
} from "@devloop/shared";

export interface RunOnceDeps {
  config?: AppConfig;
  redmine?: RedmineClient;
  git?: GitOps;
  copilot?: CopilotRunner;
  pid?: number;
}

export type RunOnceResult =
  | { outcome: "busy_running_elsewhere" }
  | { outcome: "idle_paused" }
  | { outcome: "idle_empty" }
  | { outcome: "recovered_crash"; ticketId: number }
  | { outcome: "pushed"; ticketId: number }
  | { outcome: "needs_human"; ticketId: number; reason: string }
  | { outcome: "canceled"; ticketId: number }
  | { outcome: "reverted_waiting"; ticketId: number; reason: string };

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isRunnerStale(runner: RunnerState, staleThresholdMinutes: number): boolean {
  if (!runner.pid || !runner.heartbeatAt) return true;
  if (!isProcessAlive(runner.pid)) return true;
  const ageMs = Date.now() - new Date(runner.heartbeatAt).getTime();
  return ageMs > staleThresholdMinutes * 60_000;
}

async function tryAddComment(redmine: RedmineClient, ticketNo: string, notes: string): Promise<boolean> {
  try {
    await redmine.addComment(ticketNo, notes);
    return true;
  } catch {
    // ベストエフォート。コメント登録の失敗でチケットの状態遷移は止めない。
    return false;
  }
}

async function stashSafely(git: GitOps, message: string, reason: string): Promise<void> {
  try {
    await git.stashAsWip(message, reason);
  } catch {
    // 退避に失敗しても後続の状態更新・コメント登録は継続する（要確認扱いになるため調査可能）。
  }
}

function wipMessage(ticketNo: string, subject: string): string {
  return `[WIP] #${ticketNo} ${subject}`.trimEnd();
}

/**
 * 着手前に見つかった残留変更のコミットメッセージ。
 * 残留物は「今から着手するチケット」ではなく「直前に処理していたチケット」の作業なので、
 * 現在のブランチ名からチケット番号を復元する。
 */
async function residueWipMessage(git: GitOps): Promise<string> {
  let branch = "";
  try {
    branch = await git.currentBranch();
  } catch {
    branch = "";
  }
  const ticketNo = branch.match(/^ticket\/(\d+)$/)?.[1];
  return ticketNo ? wipMessage(ticketNo, "(前回処理の残留変更)") : `[WIP] 前回処理の残留変更 (${branch || "unknown"})`;
}

export async function runOnce(deps: RunOnceDeps = {}): Promise<RunOnceResult> {
  const config = deps.config ?? loadConfig();
  const dataDir = config.dataDir!;
  const redmine = deps.redmine ?? createRedmineClient(config.redmine);
  const git = deps.git ?? createGitOps(config.git);
  const copilot = deps.copilot ?? createCopilotRunner(config.copilot);
  const pid = deps.pid ?? process.pid;

  // 1-3. 多重起動防止・異常終了検知・チケットの確保を1回のロック内で行う
  const claim = await claimNextTicket(dataDir, pid, (runner) =>
    isRunnerStale(runner, config.runner.staleThresholdMinutes)
  );
  if (claim.kind === "busy") return { outcome: "busy_running_elsewhere" };
  if (claim.kind === "stale") return recoverFromCrash(dataDir, git, redmine, claim.ticketId);
  if (claim.kind === "paused") return { outcome: "idle_paused" };
  if (claim.kind === "empty") return { outcome: "idle_empty" };
  const ticket = claim.ticket;

  // 4. 作業ツリーに前回処理の残留物があれば退避する。
  //    退避先は現在チェックアウト中のブランチなので、コミットメッセージもそのブランチ基準で作る。
  await stashSafely(git, await residueWipMessage(git), "前回処理の残留物を退避");

  const branchName = `ticket/${ticket.redmineTicketNo}`;
  const settings = await getSettings(dataDir);
  const implModel = ticket.implModel ?? settings.defaultImplModel;
  const reviewModel = ticket.reviewModel ?? settings.defaultReviewModel;

  let heartbeatTimer: NodeJS.Timeout | undefined;
  const startHeartbeat = () => {
    heartbeatTimer = setInterval(() => {
      // 失敗を握りつぶさずに捕捉する。未処理のPromise拒否はNodeの既定ではプロセス停止になり、
      // 実装作業中のエンジンが落ちてしまうため。
      updateHeartbeat(dataDir, ticket.id).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[devloop-engine] ハートビートの更新に失敗しました", err);
      });
    }, config.runner.heartbeatIntervalSeconds * 1000);
  };
  const stopHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  };
  const shouldAbort = () => isAbortRequested(dataDir, ticket.id);

  try {
    startHeartbeat();

    // 6. Redmineからチケット情報を取得
    let issue: RedmineIssue;
    try {
      issue = await redmine.getIssue(ticket.redmineTicketNo);
    } catch (err) {
      const message = (err as Error).message;
      await appendLog(dataDir, ticket.id, "error", message);
      if (err instanceof RedmineNotFoundError) {
        await finishTicket(dataDir, ticket.id, "needs_human", message);
        return { outcome: "needs_human", ticketId: ticket.id, reason: message };
      }
      await revertToWaiting(dataDir, ticket.id, message);
      return { outcome: "reverted_waiting", ticketId: ticket.id, reason: message };
    }
    await updateTicketTitle(dataDir, ticket.id, issue.subject);

    // 7-11. ブランチ作成〜実装〜レビュー〜差し戻し〜プッシュ。
    // git/Copilot CLI呼び出しで予期しない例外が出た場合もneeds_humanへ倒し、
    // 次回スケジュール起動に影響を与えない（非機能設計参照）。
    try {
      await git.ensureBranch(branchName);

      let reviewFeedback: string | undefined;
      const retryLimit = settings.retryLimit;

      /** 差し戻して再実装させる。上限に達した場合は終了結果を返す */
      const requestRetry = async (feedback: string): Promise<RunOnceResult | undefined> => {
        const retryCount = await incrementRetry(dataDir, ticket.id);
        if (retryCount > retryLimit) {
          return handleRetryLimitExceeded(dataDir, git, redmine, ticket.id, issue);
        }
        await appendLog(dataDir, ticket.id, "retry", `retryCount ${retryCount}/${retryLimit}。指摘内容を実装AIへ渡します。`);
        reviewFeedback = feedback;
        return undefined;
      };

      for (;;) {
        if (await shouldAbort()) return handleAbort(dataDir, git, ticket.id);

        const implResult = await copilot.run({
          model: implModel,
          prompt: buildImplementPrompt(issue, reviewFeedback),
          cwd: config.git.repoPath,
          timeoutMs: settings.implTimeoutMinutes * 60_000,
          shouldAbort,
          abortPollIntervalMs: config.runner.abortPollIntervalSeconds * 1000,
        });
        if (implResult.aborted) return handleAbort(dataDir, git, ticket.id);
        if (implResult.timedOut) return handleTimeout(dataDir, git, redmine, ticket.id, issue, "実装フェーズ");
        await appendLog(dataDir, ticket.id, "implement", implResult.output || "(出力なし)");

        if (await shouldAbort()) return handleAbort(dataDir, git, ticket.id);

        // 実装AIが何も変更しなかった場合は、レビューへ進めず差し戻して作り直させる
        if (await git.isClean()) {
          const message = "実装AIが変更を生成しませんでした。";
          await appendLog(dataDir, ticket.id, "review", message);
          const limitReached = await requestRetry(
            `${message}\nチケットの内容にもとづき、実際にファイルを変更してください。`
          );
          if (limitReached) return limitReached;
          continue;
        }

        const diffSummary = await git.diffSummary();
        const reviewResult = await copilot.run({
          model: reviewModel,
          prompt: buildReviewPrompt(issue, diffSummary),
          cwd: config.git.repoPath,
          timeoutMs: settings.reviewTimeoutMinutes * 60_000,
          shouldAbort,
          abortPollIntervalMs: config.runner.abortPollIntervalSeconds * 1000,
        });
        if (reviewResult.aborted) return handleAbort(dataDir, git, ticket.id);
        if (reviewResult.timedOut) return handleTimeout(dataDir, git, redmine, ticket.id, issue, "レビューフェーズ");
        await appendLog(dataDir, ticket.id, "review", reviewResult.output || "(出力なし)");

        if (parseReviewVerdict(reviewResult.output) === "pass") break;

        const limitReached = await requestRetry(reviewResult.output);
        if (limitReached) return limitReached;
      }

      const committed = await git.commitAll(ticket.redmineTicketNo, issue.subject);
      await appendLog(
        dataDir,
        ticket.id,
        "push",
        committed ? `${branchName} をコミットしました。` : "差分がなかったため、コミットは行いませんでした。"
      );
      await git.push(branchName);
      await appendLog(dataDir, ticket.id, "push", `${branchName} を origin へ push しました。`);

      const commentOk = await tryAddComment(
        redmine,
        ticket.redmineTicketNo,
        `実装が完了しました。ブランチ: ${branchName}\nプルリクエストの作成をご検討ください。`
      );
      await appendLog(
        dataDir,
        ticket.id,
        "push",
        commentOk ? "Redmineに完了コメントを登録しました。" : "Redmineへのコメント登録に失敗しました（作業自体は完了しています）。"
      );

      await finishTicket(dataDir, ticket.id, "pushed", null);
      return { outcome: "pushed", ticketId: ticket.id };
    } catch (error) {
      return handleUnexpectedError(dataDir, git, redmine, ticket.id, ticket.redmineTicketNo, issue.subject, error);
    }
  } finally {
    stopHeartbeat();
  }
}

async function recoverFromCrash(
  dataDir: string,
  git: GitOps,
  redmine: RedmineClient,
  ticketId: number
): Promise<RunOnceResult> {
  const q = await getQueue(dataDir);
  const ticket = q.items.find((t) => t.id === ticketId);
  const reason = "実行エンジンの異常終了により処理が中断しました。要確認をお願いします。";
  if (ticket) {
    await stashSafely(git, wipMessage(ticket.redmineTicketNo, ticket.title ?? ""), reason);
    await tryAddComment(redmine, ticket.redmineTicketNo, reason);
  }
  await appendLog(dataDir, ticketId, "recover", reason);
  await finishTicket(dataDir, ticketId, "needs_human", reason);
  return { outcome: "recovered_crash", ticketId };
}

async function handleAbort(dataDir: string, git: GitOps, ticketId: number): Promise<RunOnceResult> {
  const q = await getQueue(dataDir);
  const ticket = q.items.find((t) => t.id === ticketId);
  await stashSafely(
    git,
    wipMessage(ticket?.redmineTicketNo ?? String(ticketId), ticket?.title ?? ""),
    "利用者の操作により中断"
  );
  await appendLog(dataDir, ticketId, "abort", "中断要求を検知し、処理を停止しました。作業内容はWIPコミットとして退避しました。");
  await finishTicket(dataDir, ticketId, "canceled", "利用者の操作により中断しました");
  return { outcome: "canceled", ticketId };
}

async function handleTimeout(
  dataDir: string,
  git: GitOps,
  redmine: RedmineClient,
  ticketId: number,
  issue: RedmineIssue,
  phaseLabel: string
): Promise<RunOnceResult> {
  const message = `${phaseLabel}がタイムアウトしました。`;
  await stashSafely(git, wipMessage(issue.id, issue.subject), message);
  await appendLog(dataDir, ticketId, "timeout", message);
  await tryAddComment(redmine, issue.id, `${message}要確認をお願いします。`);
  await finishTicket(dataDir, ticketId, "needs_human", message);
  return { outcome: "needs_human", ticketId, reason: message };
}

async function handleUnexpectedError(
  dataDir: string,
  git: GitOps,
  redmine: RedmineClient,
  ticketId: number,
  ticketNo: string,
  subject: string,
  error: unknown
): Promise<RunOnceResult> {
  const message = `予期しないエラーが発生しました: ${(error as Error).message}`;
  await stashSafely(git, wipMessage(ticketNo, subject), message);
  await appendLog(dataDir, ticketId, "error", message);
  await tryAddComment(redmine, ticketNo, `${message}\n要確認（人対応）をお願いします。`);
  await finishTicket(dataDir, ticketId, "needs_human", message);
  return { outcome: "needs_human", ticketId, reason: message };
}

async function handleRetryLimitExceeded(
  dataDir: string,
  git: GitOps,
  redmine: RedmineClient,
  ticketId: number,
  issue: RedmineIssue
): Promise<RunOnceResult> {
  const message = "再実装ループが上限に達しました。";
  await stashSafely(git, wipMessage(issue.id, issue.subject), message);
  await appendLog(dataDir, ticketId, "error", message);
  await tryAddComment(redmine, issue.id, `${message}要確認（人対応）をお願いします。`);
  await finishTicket(dataDir, ticketId, "needs_human", message);
  return { outcome: "needs_human", ticketId, reason: message };
}
