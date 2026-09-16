import * as path from "node:path";
import { withFileLock, readWithDefault } from "./jsonStore";
import { Errors } from "./errors";
import type { QueueFile, Ticket, TicketStatus } from "./types";

const ACTIVE_STATUSES: TicketStatus[] = ["waiting", "running"];

function emptyQueue(): QueueFile {
  return {
    nextId: 1,
    queuePaused: false,
    runner: { ticketId: null, pid: null, heartbeatAt: null },
    abortRequestedTicketId: null,
    items: [],
  };
}

function queuePath(dataDir: string): string {
  return path.join(dataDir, "queue.json");
}

export async function getQueue(dataDir: string): Promise<QueueFile> {
  return readWithDefault<QueueFile>(queuePath(dataDir), emptyQueue());
}

export function queueItems(q: QueueFile): Ticket[] {
  return q.items.filter((t) => t.status === "waiting" || t.status === "running");
}

export function historyItems(q: QueueFile): Ticket[] {
  return q.items.filter((t) => t.status !== "waiting" && t.status !== "running");
}

/** waitingチケットのorderIndexを0始まりの連番に振り直す */
function renumberWaiting(items: Ticket[]): void {
  const waiting = items.filter((t) => t.status === "waiting").sort((a, b) => a.orderIndex - b.orderIndex);
  waiting.forEach((t, i) => {
    t.orderIndex = i;
  });
}

export interface AddTicketInput {
  redmineTicketNo: string;
  title: string | null;
  implModel?: string | null;
  reviewModel?: string | null;
  registeredBy: string;
}

export async function addTicket(dataDir: string, input: AddTicketInput): Promise<Ticket> {
  let created!: Ticket;
  await withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    const duplicate = q.items.some(
      (t) => t.redmineTicketNo === input.redmineTicketNo && ACTIVE_STATUSES.includes(t.status)
    );
    if (duplicate) throw Errors.duplicateTicket();

    const waitingCount = q.items.filter((t) => t.status === "waiting").length;
    created = {
      id: q.nextId,
      redmineTicketNo: input.redmineTicketNo,
      title: input.title,
      status: "waiting",
      orderIndex: waitingCount,
      implModel: input.implModel ?? null,
      reviewModel: input.reviewModel ?? null,
      retryCount: 0,
      registeredBy: input.registeredBy,
      registeredAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      branchName: null,
      lastError: null,
    };
    q.nextId += 1;
    q.items.push(created);
    return q;
  });
  return created;
}

export async function updateOrder(dataDir: string, id: number, newIndex: number): Promise<QueueFile> {
  return withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    const target = q.items.find((t) => t.id === id);
    if (!target) throw Errors.ticketNotFound();
    if (target.status !== "waiting") throw Errors.ticketNotWaiting();

    const waiting = q.items.filter((t) => t.status === "waiting").sort((a, b) => a.orderIndex - b.orderIndex);
    const from = waiting.findIndex((t) => t.id === id);
    waiting.splice(from, 1);
    const clamped = Math.max(0, Math.min(newIndex, waiting.length));
    waiting.splice(clamped, 0, target);
    waiting.forEach((t, i) => {
      t.orderIndex = i;
    });
    return q;
  });
}

export interface ModelUpdate {
  implModel?: string | null;
  reviewModel?: string | null;
}

export async function updateModels(dataDir: string, id: number, update: ModelUpdate): Promise<Ticket> {
  let updated!: Ticket;
  await withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    const target = q.items.find((t) => t.id === id);
    if (!target) throw Errors.ticketNotFound();
    if (target.status !== "waiting") throw Errors.ticketNotWaiting();
    if (update.implModel !== undefined) target.implModel = update.implModel;
    if (update.reviewModel !== undefined) target.reviewModel = update.reviewModel;
    updated = target;
    return q;
  });
  return updated;
}

export async function deleteTicket(dataDir: string, id: number): Promise<void> {
  await withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    const target = q.items.find((t) => t.id === id);
    if (!target) throw Errors.ticketNotFound();
    if (target.status === "running") throw Errors.ticketRunning();
    q.items = q.items.filter((t) => t.id !== id);
    renumberWaiting(q.items);
    return q;
  });
}

export async function requestAbort(dataDir: string, id: number): Promise<void> {
  await withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    const target = q.items.find((t) => t.id === id);
    if (!target) throw Errors.ticketNotFound();
    if (target.status !== "running") throw Errors.ticketNotRunning();
    q.abortRequestedTicketId = id;
    return q;
  });
}

export async function setPaused(dataDir: string, paused: boolean): Promise<QueueFile> {
  return withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    q.queuePaused = paused;
    return q;
  });
}

// ---------------------------------------------------------------------------
// 実行エンジンから使う低レベル操作
// ---------------------------------------------------------------------------

/** waitingのうちorderIndexが最小のチケットを返す（なければundefined） */
export function pickNextWaiting(q: QueueFile): Ticket | undefined {
  return q.items
    .filter((t) => t.status === "waiting")
    .sort((a, b) => a.orderIndex - b.orderIndex)[0];
}

export type ClaimResult =
  | { kind: "claimed"; ticket: Ticket }
  | { kind: "busy" }
  | { kind: "stale"; ticketId: number }
  | { kind: "paused" }
  | { kind: "empty" };

/**
 * 「他の実行エンジンが動いていないことの確認」と「先頭チケットの確保」を1回のロック内で行う。
 * 確認と確保が別トランザクションだと、同時に起動した2つのエンジンが同じチケットを
 * 二重に処理しうるため、ここで不可分に行う。
 */
export async function claimNextTicket(
  dataDir: string,
  pid: number,
  isStale: (runner: QueueFile["runner"]) => boolean
): Promise<ClaimResult> {
  let result: ClaimResult = { kind: "empty" };
  await withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    if (q.runner.ticketId != null) {
      result = isStale(q.runner) ? { kind: "stale", ticketId: q.runner.ticketId } : { kind: "busy" };
      return q;
    }
    if (q.queuePaused) {
      result = { kind: "paused" };
      return q;
    }
    const target = pickNextWaiting(q);
    if (!target) {
      result = { kind: "empty" };
      return q;
    }
    const now = new Date().toISOString();
    target.status = "running";
    target.startedAt = now;
    target.branchName = `ticket/${target.redmineTicketNo}`;
    q.runner = { ticketId: target.id, pid, heartbeatAt: now };
    result = { kind: "claimed", ticket: { ...target } };
    return q;
  });
  return result;
}

export async function startRunning(dataDir: string, ticketId: number, pid: number): Promise<Ticket> {
  let started!: Ticket;
  await withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    const target = q.items.find((t) => t.id === ticketId);
    if (!target) throw Errors.ticketNotFound();
    const now = new Date().toISOString();
    target.status = "running";
    target.startedAt = now;
    target.branchName = `ticket/${target.redmineTicketNo}`;
    q.runner = { ticketId, pid, heartbeatAt: now };
    started = target;
    return q;
  });
  return started;
}

export async function updateHeartbeat(dataDir: string, ticketId: number): Promise<void> {
  await withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    if (q.runner.ticketId === ticketId) {
      q.runner.heartbeatAt = new Date().toISOString();
    }
    return q;
  });
}

export async function updateTicketTitle(dataDir: string, id: number, title: string): Promise<void> {
  await withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    const target = q.items.find((t) => t.id === id);
    if (target) target.title = title;
    return q;
  });
}

export async function incrementRetry(dataDir: string, id: number): Promise<number> {
  let retryCount = 0;
  await withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    const target = q.items.find((t) => t.id === id);
    if (target) {
      target.retryCount += 1;
      retryCount = target.retryCount;
    }
    return q;
  });
  return retryCount;
}

/** チケットを終端状態にし、runnerとabort要求をクリアする */
export async function finishTicket(
  dataDir: string,
  id: number,
  status: Extract<TicketStatus, "needs_human" | "pushed" | "canceled">,
  lastError: string | null
): Promise<void> {
  await withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    const target = q.items.find((t) => t.id === id);
    if (target) {
      target.status = status;
      target.finishedAt = new Date().toISOString();
      target.lastError = lastError;
    }
    if (q.runner.ticketId === id) {
      q.runner = { ticketId: null, pid: null, heartbeatAt: null };
    }
    if (q.abortRequestedTicketId === id) {
      q.abortRequestedTicketId = null;
    }
    return q;
  });
}

/** チケットを waiting に戻す（一時的なエラーからの再試行用） */
export async function revertToWaiting(dataDir: string, id: number, lastError: string | null): Promise<void> {
  await withFileLock<QueueFile>(queuePath(dataDir), emptyQueue(), (q) => {
    const target = q.items.find((t) => t.id === id);
    if (target) {
      target.status = "waiting";
      target.startedAt = null;
      target.lastError = lastError;
    }
    if (q.runner.ticketId === id) {
      q.runner = { ticketId: null, pid: null, heartbeatAt: null };
    }
    return q;
  });
}

export async function isAbortRequested(dataDir: string, id: number): Promise<boolean> {
  const q = await getQueue(dataDir);
  return q.abortRequestedTicketId === id;
}
