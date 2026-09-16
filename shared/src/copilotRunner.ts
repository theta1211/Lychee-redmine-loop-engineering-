import { spawn, ChildProcess } from "node:child_process";
import type { AppConfig } from "./types";

export interface CopilotRunOptions {
  model: string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  /** trueを返した時点で、フェーズの完了を待たずプロセスを即座にkillする（強制中断用） */
  shouldAbort?: () => Promise<boolean> | boolean;
  abortPollIntervalMs?: number;
}

export interface CopilotRunResult {
  output: string;
  timedOut: boolean;
  aborted: boolean;
  exitCode: number | null;
}

/**
 * GitHub Copilot CLIの起動オプションはCLIのバージョンに依存するため、
 * `--model` / `--prompt` は仮のインターフェースとしている。
 * 導入時に実際のCLI仕様へ合わせて調整すること（detailed-design.md 10章参照）。
 */
export function createCopilotRunner(config: AppConfig["copilot"]) {
  async function run(opts: CopilotRunOptions): Promise<CopilotRunResult> {
    if (config.mock) return runMock(opts);
    return runReal(config, opts);
  }
  return { run };
}

function runReal(config: AppConfig["copilot"], opts: CopilotRunOptions): Promise<CopilotRunResult> {
  return new Promise((resolve, reject) => {
    // プロンプトはコマンドライン引数ではなく標準入力から渡す。
    // チケット本文やレビュー指摘を丸ごと含むため、Windowsの引数長制限・
    // 改行やクォートのエスケープで壊れるのを避ける。
    const args = [...config.extraArgs, "--model", opts.model];
    const child: ChildProcess = spawn(config.command, args, { cwd: opts.cwd });
    child.stdin?.on("error", () => {
      // 子プロセスが先に終了した場合のEPIPEは無視する（終了コードとして扱う）
    });
    child.stdin?.end(opts.prompt);

    let output = "";
    let settled = false;
    let abortTimer: NodeJS.Timeout | undefined;

    const finish = (result: CopilotRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (abortTimer) clearInterval(abortTimer);
      resolve(result);
    };

    child.stdout?.on("data", (d) => (output += d.toString()));
    child.stderr?.on("data", (d) => (output += d.toString()));

    const timeoutTimer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ output, timedOut: true, aborted: false, exitCode: null });
    }, opts.timeoutMs);

    if (opts.shouldAbort) {
      const interval = opts.abortPollIntervalMs ?? 5000;
      abortTimer = setInterval(() => {
        if (settled) return;
        void (async () => {
          try {
            if (await opts.shouldAbort!()) {
              child.kill("SIGTERM");
              finish({ output, timedOut: false, aborted: true, exitCode: null });
            }
          } catch {
            // 中断要求の確認に失敗しても実行は継続する（次回のポーリングで再確認する）
          }
        })();
      }, interval);
    }

    child.on("close", (code) => finish({ output, timedOut: false, aborted: false, exitCode: code }));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (abortTimer) clearInterval(abortTimer);
      reject(err);
    });
  });
}

/** ローカル開発・テスト用のスタブ。実際のCopilot CLIを起動しない（config.copilot.mock=true時に使用） */
async function runMock(opts: CopilotRunOptions): Promise<CopilotRunResult> {
  return {
    output: `RESULT: PASS\n(mock runner) model=${opts.model}`,
    timedOut: false,
    aborted: false,
    exitCode: 0,
  };
}

export type CopilotRunner = ReturnType<typeof createCopilotRunner>;

/** レビューAIの出力から RESULT: PASS / RESULT: FAIL を読み取る。見つからなければFAIL扱い */
export function parseReviewVerdict(output: string): "pass" | "fail" {
  const match = output.match(/RESULT:\s*(PASS|FAIL)/i);
  if (!match) return "fail";
  return match[1].toUpperCase() === "PASS" ? "pass" : "fail";
}
