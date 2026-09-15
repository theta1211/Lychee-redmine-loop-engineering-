import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendLog, readLogs, deleteLogs } from "../logStore";
import { getSettings, updateSettings, DEFAULT_SETTINGS } from "../settingsStore";
import { AppError } from "../errors";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devloop-log-settings-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("logStore", () => {
  it("ログはJSON Lines形式で追記され、順序どおり読み出せる", async () => {
    await appendLog(dataDir, 1, "implement", "実装を開始しました");
    await appendLog(dataDir, 1, "review", "RESULT: FAIL");
    const logs = await readLogs(dataDir, 1);
    expect(logs.map((l) => l.phase)).toEqual(["implement", "review"]);
    expect(logs[1].content).toBe("RESULT: FAIL");
  });

  it("ログがないチケットは空配列を返す", async () => {
    expect(await readLogs(dataDir, 999)).toEqual([]);
  });

  it("削除するとログファイルが消える", async () => {
    await appendLog(dataDir, 2, "push", "done");
    await deleteLogs(dataDir, 2);
    expect(await readLogs(dataDir, 2)).toEqual([]);
  });
});

describe("settingsStore", () => {
  it("初回はデフォルト値を返す", async () => {
    expect(await getSettings(dataDir)).toEqual(DEFAULT_SETTINGS);
  });

  it("部分更新でき、指定外のフィールドは維持される", async () => {
    await updateSettings(dataDir, { retryLimit: 5 });
    const s = await updateSettings(dataDir, { defaultImplModel: "claude-sonnet" });
    expect(s.retryLimit).toBe(5);
    expect(s.defaultImplModel).toBe("claude-sonnet");
  });

  it("不正な値はAppErrorになる", async () => {
    await expect(updateSettings(dataDir, { retryLimit: 0 })).rejects.toBeInstanceOf(AppError);
    await expect(updateSettings(dataDir, { implTimeoutMinutes: -1 })).rejects.toMatchObject({
      code: "INVALID_TIMEOUT",
    });
  });
});
