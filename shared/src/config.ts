import * as fs from "node:fs";
import * as path from "node:path";
import type { AppConfig } from "./types";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

let cached: AppConfig | undefined;

/**
 * config/config.json を読み込む。存在しない場合はエラーにせず、
 * ローカル開発・テストが継続できるよう安全な既定値を返す。
 */
export function loadConfig(configPath?: string): AppConfig {
  if (cached && !configPath) return cached;

  const resolvedPath =
    configPath ?? process.env.DEVLOOP_CONFIG_PATH ?? path.join(REPO_ROOT, "config", "config.json");
  let loaded: Partial<AppConfig> = {};
  if (fs.existsSync(resolvedPath)) {
    loaded = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  }

  const config: AppConfig = {
    redmine: {
      url: loaded.redmine?.url ?? "",
      apiKey: loaded.redmine?.apiKey ?? "",
    },
    git: {
      repoPath: loaded.git?.repoPath ?? "",
      baseBranch: loaded.git?.baseBranch ?? "main",
      remote: loaded.git?.remote ?? "origin",
    },
    copilot: {
      command: loaded.copilot?.command ?? "copilot",
      extraArgs: loaded.copilot?.extraArgs ?? [],
      mock: loaded.copilot?.mock ?? false,
    },
    runner: {
      staleThresholdMinutes: loaded.runner?.staleThresholdMinutes ?? 5,
      heartbeatIntervalSeconds: loaded.runner?.heartbeatIntervalSeconds ?? 30,
      abortPollIntervalSeconds: loaded.runner?.abortPollIntervalSeconds ?? 5,
    },
    // 相対パスで指定された場合もプロセスのcwdに依存しないよう、リポジトリルート基準で解決する
    dataDir: loaded.dataDir ? path.resolve(REPO_ROOT, loaded.dataDir) : path.join(REPO_ROOT, "data"),
  };

  if (!configPath) cached = config;
  return config;
}

export function resetConfigCacheForTests(): void {
  cached = undefined;
}

export function repoRoot(): string {
  return REPO_ROOT;
}
