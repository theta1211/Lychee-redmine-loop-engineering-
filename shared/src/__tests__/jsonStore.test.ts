import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock, readWithDefault, writeJsonAtomic } from "../jsonStore";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devloop-jsonstore-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("jsonStore", () => {
  it("ファイルが存在しない場合は初期値で作成される", async () => {
    const file = path.join(dataDir, "sub", "x.json");
    const value = await readWithDefault(file, { count: 0 });
    expect(value).toEqual({ count: 0 });
    expect(fs.existsSync(file)).toBe(true);
  });

  it(
    "withFileLockは同時実行しても更新を取りこぼさない",
    async () => {
      const file = path.join(dataDir, "counter.json");
      await writeJsonAtomic(file, { count: 0 });

      const increments = Array.from({ length: 20 }, () =>
        withFileLock<{ count: number }>(file, { count: 0 }, (cur) => ({ count: cur.count + 1 }))
      );
      await Promise.all(increments);

      const final = await readWithDefault(file, { count: -1 });
      expect(final.count).toBe(20);
    },
    15000
  );

  it("mutatorが例外を投げた場合はファイルを書き換えない", async () => {
    const file = path.join(dataDir, "guard.json");
    await writeJsonAtomic(file, { count: 1 });
    await expect(
      withFileLock<{ count: number }>(file, { count: 0 }, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const value = await readWithDefault(file, { count: -1 });
    expect(value.count).toBe(1);
  });
});
