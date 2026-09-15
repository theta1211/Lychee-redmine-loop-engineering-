import * as path from "node:path";
import { withFileLock, readWithDefault } from "./jsonStore";
import { AppError } from "./errors";
import type { Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
  defaultImplModel: "gpt-4o",
  defaultReviewModel: "gpt-4o",
  retryLimit: 3,
  implTimeoutMinutes: 30,
  reviewTimeoutMinutes: 10,
};

function settingsPath(dataDir: string): string {
  return path.join(dataDir, "settings.json");
}

export async function getSettings(dataDir: string): Promise<Settings> {
  return readWithDefault<Settings>(settingsPath(dataDir), DEFAULT_SETTINGS);
}

export interface SettingsUpdate {
  defaultImplModel?: string;
  defaultReviewModel?: string;
  retryLimit?: number;
  implTimeoutMinutes?: number;
  reviewTimeoutMinutes?: number;
}

function assertPositiveInt(value: number | undefined, code: string, label: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError(code, `${label}は1以上の整数で指定してください`);
  }
}

export async function updateSettings(dataDir: string, update: SettingsUpdate): Promise<Settings> {
  assertPositiveInt(update.retryLimit, "INVALID_RETRY_LIMIT", "再実装ループの上限回数");
  assertPositiveInt(update.implTimeoutMinutes, "INVALID_TIMEOUT", "実装フェーズのタイムアウト");
  assertPositiveInt(update.reviewTimeoutMinutes, "INVALID_TIMEOUT", "レビューフェーズのタイムアウト");

  return withFileLock<Settings>(settingsPath(dataDir), DEFAULT_SETTINGS, (current) => ({
    ...current,
    ...update,
  }));
}
