import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  addTicket,
  getQueue,
  setPaused,
  startRunning,
  requestAbort,
  updateSettings,
  readLogs,
  RedmineNotFoundError,
  RedmineUnavailableError,
  type AppConfig,
  type RedmineClient,
  type RedmineIssue,
  type GitOps,
  type CopilotRunner,
  type CopilotRunOptions,
  type CopilotRunResult,
} from "@devloop/shared";
import { runOnce } from "../runOnce";

let dataDir: string;

function baseConfig(): AppConfig {
  return {
    redmine: { url: "http://redmine.example", apiKey: "dummy" },
    git: { repoPath: "/tmp/does-not-matter", baseBranch: "main", remote: "origin" },
    copilot: { command: "copilot", extraArgs: [], mock: true },
    runner: { staleThresholdMinutes: 5, heartbeatIntervalSeconds: 30, abortPollIntervalSeconds: 5 },
    dataDir,
  };
}

function fakeRedmine(overrides: Partial<RedmineClient> = {}): RedmineClient & { comments: Array<{ no: string; notes: string }> } {
  const comments: Array<{ no: string; notes: string }> = [];
  return {
    getIssue: async (no: string): Promise<RedmineIssue> => ({
      id: no,
      subject: `テストチケット${no}`,
      description: "説明文",
      status: "新規",
    }),
    addComment: async (no: string, notes: string) => {
      comments.push({ no, notes });
    },
    comments,
    ...overrides,
  };
}

function fakeGit(overrides: Partial<GitOps> = {}) {
  const calls: { ensureBranch: string[]; stashAsWip: Array<{ no: string; reason: string }>; commitAll: string[]; push: string[] } = {
    ensureBranch: [],
    stashAsWip: [],
    commitAll: [],
    push: [],
  };
  const git: GitOps & { calls: typeof calls } = {
    isClean: async () => true,
    stashAsWip: async (no: string, _subject: string, reason: string) => {
      calls.stashAsWip.push({ no, reason });
      return true;
    },
    ensureBranch: async (branch: string) => {
      calls.ensureBranch.push(branch);
    },
    commitAll: async (no: string) => {
      calls.commitAll.push(no);
      return true;
    },
    push: async (branch: string) => {
      calls.push.push(branch);
    },
    diffSummary: async () => "+1 -0 file.txt",
    calls,
    ...overrides,
  };
  return git;
}

function scriptedCopilot(
  script: (opts: CopilotRunOptions, callIndex: number) => Partial<CopilotRunResult> | Promise<Partial<CopilotRunResult>>
): CopilotRunner {
  let callIndex = 0;
  return {
    run: async (opts) => {
      const partial = await script(opts, callIndex);
      callIndex += 1;
      return { output: "", timedOut: false, aborted: false, exitCode: 0, ...partial };
    },
  };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devloop-engine-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("runOnce: 起動条件", () => {
  it("キューが一時停止中なら何もしない", async () => {
    await setPaused(dataDir, true);
    const result = await runOnce({ config: baseConfig(), redmine: fakeRedmine(), git: fakeGit(), copilot: scriptedCopilot(() => ({})) });
    expect(result).toEqual({ outcome: "idle_paused" });
  });

  it("待機中チケットがなければ何もしない", async () => {
    const result = await runOnce({ config: baseConfig(), redmine: fakeRedmine(), git: fakeGit(), copilot: scriptedCopilot(() => ({})) });
    expect(result).toEqual({ outcome: "idle_empty" });
  });

  it("実行中プロセスが生きていれば多重起動しない", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "1", title: "A", registeredBy: "u1" });
    await startRunning(dataDir, t.id, process.pid); // 自プロセス=生存中
    const result = await runOnce({ config: baseConfig(), redmine: fakeRedmine(), git: fakeGit(), copilot: scriptedCopilot(() => ({})) });
    expect(result).toEqual({ outcome: "busy_running_elsewhere" });
  });

  it("前回プロセスが死亡していれば異常終了とみなし復旧する", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "1", title: "A", registeredBy: "u1" });
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid!;
    await startRunning(dataDir, t.id, deadPid);

    const redmine = fakeRedmine();
    const git = fakeGit();
    const result = await runOnce({ config: baseConfig(), redmine, git, copilot: scriptedCopilot(() => ({})) });

    expect(result).toEqual({ outcome: "recovered_crash", ticketId: t.id });
    const q = await getQueue(dataDir);
    expect(q.items[0].status).toBe("needs_human");
    expect(q.runner.ticketId).toBeNull();
    expect(git.calls.stashAsWip).toHaveLength(1);
    expect(redmine.comments).toHaveLength(1);
  });
});

describe("runOnce: 正常系・差し戻し・上限到達", () => {
  it("レビューPASSで完了しプッシュ・コメント登録まで行う", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "42", title: null, registeredBy: "u1" });
    const redmine = fakeRedmine();
    const git = fakeGit();
    const copilot = scriptedCopilot((_opts, i) => (i === 0 ? { output: "実装しました" } : { output: "RESULT: PASS 問題ありません" }));

    const result = await runOnce({ config: baseConfig(), redmine, git, copilot });

    expect(result).toEqual({ outcome: "pushed", ticketId: t.id });
    expect(git.calls.ensureBranch).toEqual(["ticket/42"]);
    expect(git.calls.commitAll).toEqual(["42"]);
    expect(git.calls.push).toEqual(["ticket/42"]);
    expect(redmine.comments).toHaveLength(1);
    expect(redmine.comments[0].notes).toContain("ticket/42");

    const q = await getQueue(dataDir);
    expect(q.items[0].status).toBe("pushed");
    expect(q.items[0].title).toBe("テストチケット42");
    expect(q.runner.ticketId).toBeNull();

    const logs = await readLogs(dataDir, t.id);
    expect(logs.map((l) => l.phase)).toEqual(["implement", "review", "push", "push", "push"]);
  });

  it("既存の作業ツリーの残留物は着手前に退避されてから実装に進む", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "45", title: null, registeredBy: "u1" });
    const redmine = fakeRedmine();
    const git = fakeGit();
    const copilot = scriptedCopilot((_opts, i) => (i === 0 ? { output: "実装しました" } : { output: "RESULT: PASS" }));

    await runOnce({ config: baseConfig(), redmine, git, copilot });

    expect(git.calls.stashAsWip[0].reason).toContain("残留物");
  });

  it("レビューNG→差し戻し再実装→PASSで完了する", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "43", title: null, registeredBy: "u1" });
    const redmine = fakeRedmine();
    const git = fakeGit();
    const copilot = scriptedCopilot((_opts, i) => {
      if (i === 0) return { output: "実装1回目" };
      if (i === 1) return { output: "RESULT: FAIL 直してください" };
      if (i === 2) return { output: "実装2回目" };
      return { output: "RESULT: PASS" };
    });

    const result = await runOnce({ config: baseConfig(), redmine, git, copilot });

    expect(result).toEqual({ outcome: "pushed", ticketId: t.id });
    const q = await getQueue(dataDir);
    expect(q.items[0].retryCount).toBe(1);
    const logs = await readLogs(dataDir, t.id);
    expect(logs.map((l) => l.phase)).toEqual(["implement", "review", "retry", "implement", "review", "push", "push", "push"]);
  });

  it("再実装ループが上限に達したらneeds_humanになりキューから除外される", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "44", title: null, registeredBy: "u1" });
    await updateSettings(dataDir, { retryLimit: 1 });
    const redmine = fakeRedmine();
    const git = fakeGit();
    const copilot = scriptedCopilot((_opts, i) => (i % 2 === 0 ? { output: "実装" } : { output: "RESULT: FAIL 何度も直りません" }));

    const result = await runOnce({ config: baseConfig(), redmine, git, copilot });

    expect(result).toMatchObject({ outcome: "needs_human", ticketId: t.id });
    const q = await getQueue(dataDir);
    expect(q.items[0].status).toBe("needs_human");
    expect(q.items[0].retryCount).toBe(2);
    // 先頭は着手前の残留物チェック、末尾が上限到達によるWIP退避
    expect(git.calls.stashAsWip.at(-1)?.reason).toContain("上限");
    expect(git.calls.push).toHaveLength(0);
    expect(redmine.comments[0].notes).toContain("要確認");
  });
});

describe("runOnce: タイムアウト・中断", () => {
  it("実装フェーズがタイムアウトしたらneeds_humanになる", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "50", title: null, registeredBy: "u1" });
    const redmine = fakeRedmine();
    const git = fakeGit();
    const copilot = scriptedCopilot(() => ({ timedOut: true }));

    const result = await runOnce({ config: baseConfig(), redmine, git, copilot });

    expect(result).toMatchObject({ outcome: "needs_human", ticketId: t.id, reason: "実装フェーズがタイムアウトしました。" });
    const q = await getQueue(dataDir);
    expect(q.items[0].status).toBe("needs_human");
    expect(git.calls.stashAsWip.at(-1)?.reason).toContain("タイムアウト");
  });

  it("Copilot CLI自身がabortedを返したら中断としてキャンセル扱いになる", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "51", title: null, registeredBy: "u1" });
    const redmine = fakeRedmine();
    const git = fakeGit();
    const copilot = scriptedCopilot(() => ({ aborted: true }));

    const result = await runOnce({ config: baseConfig(), redmine, git, copilot });

    expect(result).toEqual({ outcome: "canceled", ticketId: t.id });
    const q = await getQueue(dataDir);
    expect(q.items[0].status).toBe("canceled");
    expect(git.calls.stashAsWip.at(-1)?.reason).toContain("中断");
  });

  it("実装完了後にWeb側からの中断要求を検知したらレビューへ進まず中断する", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "52", title: null, registeredBy: "u1" });
    const redmine = fakeRedmine();
    const git = fakeGit();
    let reviewCalled = false;
    const copilot = scriptedCopilot(async (_opts, i) => {
      if (i === 0) {
        await requestAbort(dataDir, t.id);
        return { output: "実装完了" };
      }
      reviewCalled = true;
      return { output: "RESULT: PASS" };
    });

    const result = await runOnce({ config: baseConfig(), redmine, git, copilot });

    expect(result).toEqual({ outcome: "canceled", ticketId: t.id });
    expect(reviewCalled).toBe(false);
    const q = await getQueue(dataDir);
    expect(q.abortRequestedTicketId).toBeNull();
  });
});

describe("runOnce: Redmine連携の異常系", () => {
  it("チケットがRedmine上に存在しない場合はneeds_human", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "60", title: null, registeredBy: "u1" });
    const redmine = fakeRedmine({
      getIssue: async () => {
        throw new RedmineNotFoundError("not found");
      },
    });
    const result = await runOnce({ config: baseConfig(), redmine, git: fakeGit(), copilot: scriptedCopilot(() => ({})) });
    expect(result.outcome).toBe("needs_human");
    const q = await getQueue(dataDir);
    expect(q.items[0].status).toBe("needs_human");
    void t;
  });

  it("Redmineに接続できない一時的なエラーはwaitingに戻り次回再試行される", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "61", title: null, registeredBy: "u1" });
    const redmine = fakeRedmine({
      getIssue: async () => {
        throw new RedmineUnavailableError("down");
      },
    });
    const result = await runOnce({ config: baseConfig(), redmine, git: fakeGit(), copilot: scriptedCopilot(() => ({})) });
    expect(result).toEqual({ outcome: "reverted_waiting", ticketId: t.id, reason: "down" });
    const q = await getQueue(dataDir);
    expect(q.items[0].status).toBe("waiting");
    expect(q.runner.ticketId).toBeNull();
  });
});

describe("runOnce: 予期しないエラー", () => {
  it("git操作が例外を投げてもneeds_humanに倒れ次回起動に影響しない", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "70", title: null, registeredBy: "u1" });
    const redmine = fakeRedmine();
    const git = fakeGit({
      ensureBranch: async () => {
        throw new Error("disk full");
      },
    });
    const result = await runOnce({ config: baseConfig(), redmine, git, copilot: scriptedCopilot(() => ({})) });
    expect(result).toMatchObject({ outcome: "needs_human", ticketId: t.id });
    expect((result as { reason: string }).reason).toContain("disk full");
    const q = await getQueue(dataDir);
    expect(q.items[0].status).toBe("needs_human");
    expect(q.runner.ticketId).toBeNull();
  });
});
