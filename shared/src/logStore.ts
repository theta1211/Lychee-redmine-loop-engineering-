import * as fs from "node:fs";
import * as path from "node:path";
import type { LogEntry, LogPhase } from "./types";

export function logFilePath(dataDir: string, ticketId: number): string {
  return path.join(dataDir, "logs", `${ticketId}.jsonl`);
}

export async function appendLog(
  dataDir: string,
  ticketId: number,
  phase: LogPhase,
  content: string
): Promise<void> {
  const entry: LogEntry = { phase, content, createdAt: new Date().toISOString() };
  const file = logFilePath(dataDir, ticketId);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.appendFile(file, JSON.stringify(entry) + "\n", "utf-8");
}

export async function readLogs(dataDir: string, ticketId: number): Promise<LogEntry[]> {
  const file = logFilePath(dataDir, ticketId);
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogEntry);
}

export async function deleteLogs(dataDir: string, ticketId: number): Promise<void> {
  await fs.promises.rm(logFilePath(dataDir, ticketId), { force: true });
}
