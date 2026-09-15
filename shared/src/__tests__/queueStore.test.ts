import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addTicket,
  getQueue,
  updateOrder,
  updateModels,
  deleteTicket,
  requestAbort,
  setPaused,
  startRunning,
  updateHeartbeat,
  incrementRetry,
  finishTicket,
  revertToWaiting,
  pickNextWaiting,
} from "../queueStore";
import { AppError } from "../errors";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devloop-queue-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("queueStore", () => {
  it("追加したチケットはwaitingとして末尾に入る", async () => {
    await addTicket(dataDir, { redmineTicketNo: "100", title: "A", registeredBy: "u1" });
    await addTicket(dataDir, { redmineTicketNo: "101", title: "B", registeredBy: "u1" });
    const q = await getQueue(dataDir);
    expect(q.items.map((t) => t.redmineTicketNo)).toEqual(["100", "101"]);
    expect(q.items[1].orderIndex).toBe(1);
    expect(q.nextId).toBe(3);
  });

  it("waiting/runningで同じチケット番号は重複登録できない", async () => {
    await addTicket(dataDir, { redmineTicketNo: "100", title: "A", registeredBy: "u1" });
    await expect(
      addTicket(dataDir, { redmineTicketNo: "100", title: "A", registeredBy: "u1" })
    ).rejects.toMatchObject({ code: "DUPLICATE_TICKET" });
  });

  it("履歴(needs_human等)にある番号は再登録できる", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "100", title: "A", registeredBy: "u1" });
    await startRunning(dataDir, t.id, 1234);
    await finishTicket(dataDir, t.id, "needs_human", "上限到達");
    await expect(
      addTicket(dataDir, { redmineTicketNo: "100", title: "A", registeredBy: "u1" })
    ).resolves.toMatchObject({ redmineTicketNo: "100", status: "waiting" });
  });

  it("並べ替えはwaiting同士のorderIndexを振り直す", async () => {
    const a = await addTicket(dataDir, { redmineTicketNo: "1", title: "A", registeredBy: "u1" });
    const b = await addTicket(dataDir, { redmineTicketNo: "2", title: "B", registeredBy: "u1" });
    const c = await addTicket(dataDir, { redmineTicketNo: "3", title: "C", registeredBy: "u1" });
    await updateOrder(dataDir, c.id, 0);
    const q = await getQueue(dataDir);
    const order = q.items.sort((x, y) => x.orderIndex - y.orderIndex).map((t) => t.id);
    expect(order).toEqual([c.id, a.id, b.id]);
  });

  it("running状態のチケットは並べ替えできない", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "1", title: "A", registeredBy: "u1" });
    await startRunning(dataDir, t.id, 1234);
    await expect(updateOrder(dataDir, t.id, 0)).rejects.toMatchObject({ code: "TICKET_NOT_WAITING" });
  });

  it("running状態のチケットは削除できない。中断要求はrunningのみ受け付ける", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "1", title: "A", registeredBy: "u1" });
    await expect(requestAbort(dataDir, t.id)).rejects.toMatchObject({ code: "TICKET_NOT_RUNNING" });

    await startRunning(dataDir, t.id, 1234);
    await expect(deleteTicket(dataDir, t.id)).rejects.toMatchObject({ code: "TICKET_RUNNING" });

    await requestAbort(dataDir, t.id);
    const q = await getQueue(dataDir);
    expect(q.abortRequestedTicketId).toBe(t.id);
  });

  it("startRunning/heartbeat/finishTicketでrunner状態が正しく遷移する", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "1", title: "A", registeredBy: "u1" });
    await startRunning(dataDir, t.id, 4321);
    let q = await getQueue(dataDir);
    expect(q.runner).toMatchObject({ ticketId: t.id, pid: 4321 });
    expect(pickNextWaiting(q)).toBeUndefined();

    await updateHeartbeat(dataDir, t.id);
    q = await getQueue(dataDir);
    expect(q.runner.heartbeatAt).toBeTruthy();

    await incrementRetry(dataDir, t.id);
    await incrementRetry(dataDir, t.id);
    q = await getQueue(dataDir);
    expect(q.items[0].retryCount).toBe(2);

    await finishTicket(dataDir, t.id, "pushed", null);
    q = await getQueue(dataDir);
    expect(q.runner).toEqual({ ticketId: null, pid: null, heartbeatAt: null });
    expect(q.items[0].status).toBe("pushed");
    expect(q.items[0].finishedAt).toBeTruthy();
  });

  it("revertToWaitingで一時的なエラーから再試行できる状態に戻る", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "1", title: "A", registeredBy: "u1" });
    await startRunning(dataDir, t.id, 1);
    await revertToWaiting(dataDir, t.id, "Redmineに接続できません");
    const q = await getQueue(dataDir);
    expect(q.items[0].status).toBe("waiting");
    expect(q.runner.ticketId).toBeNull();
    expect(pickNextWaiting(q)?.id).toBe(t.id);
  });

  it("モデル未指定はnullのまま保存され、waiting中のみ変更できる", async () => {
    const t = await addTicket(dataDir, { redmineTicketNo: "1", title: "A", registeredBy: "u1" });
    expect(t.implModel).toBeNull();
    await updateModels(dataDir, t.id, { implModel: "claude-sonnet" });
    const q = await getQueue(dataDir);
    expect(q.items[0].implModel).toBe("claude-sonnet");
  });

  it("キューの一時停止/再開", async () => {
    let q = await setPaused(dataDir, true);
    expect(q.queuePaused).toBe(true);
    q = await setPaused(dataDir, false);
    expect(q.queuePaused).toBe(false);
  });

  it("存在しないチケットの操作はTICKET_NOT_FOUND", async () => {
    await expect(updateOrder(dataDir, 9999, 0)).rejects.toBeInstanceOf(AppError);
  });
});
