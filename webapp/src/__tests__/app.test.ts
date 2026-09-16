import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import request from "supertest";
import { createApp } from "../app";
import { RedmineNotFoundError, RedmineUnavailableError, type AppConfig, type RedmineClient } from "@devloop/shared";

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

function fakeRedmine(overrides: Partial<RedmineClient> = {}): RedmineClient {
  return {
    getIssue: async (no: string) => ({ id: no, subject: `テストチケット${no}`, description: "説明", status: "新規" }),
    addComment: async () => {},
    ...overrides,
  };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devloop-webapp-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("認証", () => {
  it("X-Remote-Userがない場合は401", async () => {
    const app = createApp({ config: baseConfig(), redmineClient: fakeRedmine() });
    const res = await request(app).get("/api/queue");
    expect(res.status).toBe(401);
  });
});

describe("キューAPI", () => {
  const auth = { "X-Remote-User": "DOMAIN\\sato" };

  it("追加→一覧取得→並べ替え→モデル変更→削除まで一通り動く", async () => {
    const app = createApp({ config: baseConfig(), redmineClient: fakeRedmine() });

    const created = await request(app)
      .post("/api/queue")
      .set(auth)
      .send({ redmineTicketNo: "1234" });
    expect(created.status).toBe(201);
    expect(created.body.title).toBe("テストチケット1234");
    expect(created.body.status).toBe("waiting");

    const listed = await request(app).get("/api/queue").set(auth);
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);

    const reordered = await request(app)
      .put(`/api/queue/${created.body.id}/order`)
      .set(auth)
      .send({ newIndex: 0 });
    expect(reordered.status).toBe(200);

    const modelUpdated = await request(app)
      .put(`/api/queue/${created.body.id}/models`)
      .set(auth)
      .send({ implModel: "claude-sonnet" });
    expect(modelUpdated.status).toBe(200);
    expect(modelUpdated.body.implModel).toBe("claude-sonnet");

    const deleted = await request(app).delete(`/api/queue/${created.body.id}`).set(auth);
    expect(deleted.status).toBe(204);
  });

  it("モデルに空文字を指定した場合はnull（既定を使う）として保存される", async () => {
    const app = createApp({ config: baseConfig(), redmineClient: fakeRedmine() });
    const created = await request(app)
      .post("/api/queue")
      .set(auth)
      .send({ redmineTicketNo: "1", implModel: "claude-sonnet", reviewModel: "gpt-4o" });

    const updated = await request(app)
      .put(`/api/queue/${created.body.id}/models`)
      .set(auth)
      .send({ implModel: "", reviewModel: "" });

    expect(updated.status).toBe(200);
    expect(updated.body.implModel).toBeNull();
    expect(updated.body.reviewModel).toBeNull();
  });

  it("モデルのキーを省略した場合は既存の指定を維持する", async () => {
    const app = createApp({ config: baseConfig(), redmineClient: fakeRedmine() });
    const created = await request(app)
      .post("/api/queue")
      .set(auth)
      .send({ redmineTicketNo: "1", implModel: "claude-sonnet", reviewModel: "gpt-4o" });

    const updated = await request(app)
      .put(`/api/queue/${created.body.id}/models`)
      .set(auth)
      .send({ implModel: "o4-mini" });

    expect(updated.body.implModel).toBe("o4-mini");
    expect(updated.body.reviewModel).toBe("gpt-4o");
  });

  it("同じチケット番号を二重登録すると409", async () => {
    const app = createApp({ config: baseConfig(), redmineClient: fakeRedmine() });
    await request(app).post("/api/queue").set(auth).send({ redmineTicketNo: "1" });
    const res = await request(app).post("/api/queue").set(auth).send({ redmineTicketNo: "1" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DUPLICATE_TICKET");
  });

  it("Redmineに存在しないチケットは404", async () => {
    const app = createApp({
      config: baseConfig(),
      redmineClient: fakeRedmine({
        getIssue: async () => {
          throw new RedmineNotFoundError("not found");
        },
      }),
    });
    const res = await request(app).post("/api/queue").set(auth).send({ redmineTicketNo: "9999" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REDMINE_NOT_FOUND");
  });

  it("Redmineに接続できない場合は503", async () => {
    const app = createApp({
      config: baseConfig(),
      redmineClient: fakeRedmine({
        getIssue: async () => {
          throw new RedmineUnavailableError("down");
        },
      }),
    });
    const res = await request(app).post("/api/queue").set(auth).send({ redmineTicketNo: "1" });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("REDMINE_UNAVAILABLE");
  });

  it("未対応のAIモデルは400", async () => {
    const app = createApp({ config: baseConfig(), redmineClient: fakeRedmine() });
    const res = await request(app)
      .post("/api/queue")
      .set(auth)
      .send({ redmineTicketNo: "1", implModel: "unknown-model" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_MODEL");
  });

  it("実行中のチケットは削除できず、削除には強制中断が必要", async () => {
    const app = createApp({ config: baseConfig(), redmineClient: fakeRedmine() });
    const created = await request(app).post("/api/queue").set(auth).send({ redmineTicketNo: "1" });

    // 実行エンジン相当の操作を直接呼び出してrunning状態にする
    const { startRunning } = await import("@devloop/shared");
    await startRunning(dataDir, created.body.id, 111);

    const del = await request(app).delete(`/api/queue/${created.body.id}`).set(auth);
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("TICKET_RUNNING");

    const abort = await request(app).post(`/api/queue/${created.body.id}/abort`).set(auth);
    expect(abort.status).toBe(202);
  });

  it("キューの一時停止/再開", async () => {
    const app = createApp({ config: baseConfig(), redmineClient: fakeRedmine() });
    const paused = await request(app).post("/api/queue/pause").set(auth);
    expect(paused.body.queuePaused).toBe(true);
    const resumed = await request(app).post("/api/queue/resume").set(auth);
    expect(resumed.body.queuePaused).toBe(false);
  });
});

describe("設定API", () => {
  const auth = { "X-Remote-User": "DOMAIN\\sato" };

  it("参照情報付きで取得・更新できる", async () => {
    const app = createApp({ config: baseConfig(), redmineClient: fakeRedmine() });
    const got = await request(app).get("/api/settings").set(auth);
    expect(got.body.retryLimit).toBe(3);
    expect(got.body.reference.redmineUrl).toBe("http://redmine.example");

    const updated = await request(app).put("/api/settings").set(auth).send({ retryLimit: 5 });
    expect(updated.status).toBe(200);
    expect(updated.body.retryLimit).toBe(5);
  });

  it("不正な値は400", async () => {
    const app = createApp({ config: baseConfig(), redmineClient: fakeRedmine() });
    const res = await request(app).put("/api/settings").set(auth).send({ retryLimit: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_RETRY_LIMIT");
  });
});

describe("whoami", () => {
  it("X-Remote-Userの値をそのまま返す", async () => {
    const app = createApp({ config: baseConfig(), redmineClient: fakeRedmine() });
    const res = await request(app).get("/api/whoami").set("X-Remote-User", "DOMAIN\\tanaka");
    expect(res.body.user).toBe("DOMAIN\\tanaka");
  });
});
