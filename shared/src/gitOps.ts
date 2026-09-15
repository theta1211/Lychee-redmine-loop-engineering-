import simpleGit, { SimpleGit } from "simple-git";
import type { AppConfig } from "./types";

export function createGitOps(config: AppConfig["git"]) {
  const git: SimpleGit = simpleGit(config.repoPath);

  const isClean = async (): Promise<boolean> => {
    const status = await git.status();
    return status.isClean();
  };

  /** 未コミットの変更があれば [WIP] コミットとして退避する。退避した場合はtrueを返す */
  const stashAsWip = async (ticketNo: string, subject: string, reason: string): Promise<boolean> => {
    if (await isClean()) return false;
    await git.add(["-A"]);
    await git.commit(`[WIP] #${ticketNo} ${subject}\n\n${reason}`);
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

  /** レビューAIに渡す、コミット前の作業ツリーとHEADとの差分サマリ */
  const diffSummary = async (): Promise<string> => {
    const diff = await git.diff(["HEAD", "--stat"]);
    return diff.trim() || "(差分なし)";
  };

  return { isClean, stashAsWip, ensureBranch, commitAll, push, diffSummary };
}

export type GitOps = ReturnType<typeof createGitOps>;
