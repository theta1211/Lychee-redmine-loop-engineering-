import simpleGit, { SimpleGit } from "simple-git";
import type { AppConfig } from "./types";

/** レビューAIへ渡す差分の最大文字数。超えた分は切り詰める */
const MAX_DIFF_CHARS = 60_000;

export function createGitOps(config: AppConfig["git"]) {
  const git: SimpleGit = simpleGit(config.repoPath);

  const isClean = async (): Promise<boolean> => {
    const status = await git.status();
    return status.isClean();
  };

  const currentBranch = async (): Promise<string> => (await git.revparse(["--abbrev-ref", "HEAD"])).trim();

  /**
   * 未コミットの変更を [WIP] コミットとして退避する。退避した場合はtrueを返す。
   * messageにはコミットの1行目をそのまま渡す（退避対象がどのチケットの作業かは呼び出し側が決める）。
   */
  const stashAsWip = async (message: string, reason: string): Promise<boolean> => {
    if (await isClean()) return false;
    await git.add(["-A"]);
    await git.commit(`${message}\n\n${reason}`);
    return true;
  };

  /** ベースブランチを最新化し、対象ブランチへ切り替える（なければ作成する） */
  const ensureBranch = async (branchName: string): Promise<void> => {
    await git.checkout(config.baseBranch);
    await git.pull(config.remote, config.baseBranch);
    const branches = await git.branchLocal();
    if (branches.all.includes(branchName)) {
      await git.checkout(branchName);
    } else {
      await git.checkoutLocalBranch(branchName);
    }
  };

  /** 変更をコミットする。差分がなければ何もせずfalseを返す */
  const commitAll = async (ticketNo: string, subject: string): Promise<boolean> => {
    if (await isClean()) return false;
    await git.add(["-A"]);
    await git.commit(`[#${ticketNo}] ${subject}`);
    return true;
  };

  const push = async (branchName: string): Promise<void> => {
    await git.push(config.remote, branchName);
  };

  /**
   * レビューAIに渡す差分。`git diff HEAD` では新規作成ファイルが差分に現れないため、
   * いったん `git add -A` でステージしてから `git diff --cached` を取得する。
   */
  const diffSummary = async (maxChars: number = MAX_DIFF_CHARS): Promise<string> => {
    await git.add(["-A"]);
    const diff = await git.diff(["--cached"]);
    if (!diff.trim()) return "(差分なし)";
    if (diff.length > maxChars) {
      return `${diff.slice(0, maxChars)}\n\n…（差分が大きいため${maxChars}文字で切り詰めました）`;
    }
    return diff;
  };

  return { isClean, currentBranch, stashAsWip, ensureBranch, commitAll, push, diffSummary };
}

export type GitOps = ReturnType<typeof createGitOps>;
