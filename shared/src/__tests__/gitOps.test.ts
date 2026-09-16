import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createGitOps } from "../gitOps";

let repoPath: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf-8" });
}

function ops() {
  return createGitOps({ repoPath, baseBranch: "main", remote: "origin" });
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "devloop-git-"));
  git("init", "-b", "main");
  git("config", "user.email", "bot@example.com");
  git("config", "user.name", "DevLoop Bot");
  fs.writeFileSync(path.join(repoPath, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-m", "initial commit");
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("gitOps.diffSummary", () => {
  it("新規作成ファイルも差分に含まれる", async () => {
    fs.writeFileSync(path.join(repoPath, "newfile.ts"), "export const added = 1;\n");
    const diff = await ops().diffSummary();
    expect(diff).toContain("newfile.ts");
    expect(diff).toContain("export const added = 1;");
  });

  it("既存ファイルの変更内容も含まれる", async () => {
    fs.appendFileSync(path.join(repoPath, "README.md"), "追記行\n");
    const diff = await ops().diffSummary();
    expect(diff).toContain("README.md");
    expect(diff).toContain("追記行");
  });

  it("変更がなければ(差分なし)を返す", async () => {
    expect(await ops().diffSummary()).toBe("(差分なし)");
  });

  it("大きすぎる差分は指定文字数で切り詰める", async () => {
    fs.writeFileSync(path.join(repoPath, "big.txt"), "x\n".repeat(5000));
    const diff = await ops().diffSummary(500);
    expect(diff.length).toBeLessThan(700);
    expect(diff).toContain("切り詰めました");
  });
});

describe("gitOps.stashAsWip", () => {
  it("変更があれば指定メッセージでコミットし、作業ツリーをクリーンにする", async () => {
    fs.writeFileSync(path.join(repoPath, "wip.ts"), "// 作業中\n");
    const g = ops();
    expect(await g.stashAsWip("[WIP] #99 (前回処理の残留変更)", "前回処理の残留物を退避")).toBe(true);
    expect(await g.isClean()).toBe(true);
    expect(git("log", "-1", "--pretty=%B")).toContain("[WIP] #99 (前回処理の残留変更)");
  });

  it("変更がなければ何もしない", async () => {
    expect(await ops().stashAsWip("[WIP] #1 x", "理由")).toBe(false);
    expect(git("log", "--oneline").trim().split("\n")).toHaveLength(1);
  });
});

describe("gitOps.currentBranch / commitAll", () => {
  it("現在のブランチ名を返す", async () => {
    expect(await ops().currentBranch()).toBe("main");
  });

  it("差分がなければコミットせずfalseを返す", async () => {
    expect(await ops().commitAll("1", "件名")).toBe(false);
  });

  it("差分があれば規約どおりのメッセージでコミットする", async () => {
    fs.writeFileSync(path.join(repoPath, "a.ts"), "1\n");
    expect(await ops().commitAll("1234", "○○機能の追加")).toBe(true);
    expect(git("log", "-1", "--pretty=%s").trim()).toBe("[#1234] ○○機能の追加");
  });
});
