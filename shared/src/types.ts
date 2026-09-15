export type TicketStatus =
  | "waiting"
  | "running"
  | "needs_human"
  | "pushed"
  | "canceled";

export interface Ticket {
  id: number;
  redmineTicketNo: string;
  title: string | null;
  status: TicketStatus;
  orderIndex: number;
  implModel: string | null;
  reviewModel: string | null;
  retryCount: number;
  registeredBy: string;
  registeredAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  branchName: string | null;
  lastError: string | null;
}

export interface RunnerState {
  ticketId: number | null;
  pid: number | null;
  heartbeatAt: string | null;
}

export interface QueueFile {
  nextId: number;
  queuePaused: boolean;
  runner: RunnerState;
  abortRequestedTicketId: number | null;
  items: Ticket[];
}

export interface Settings {
  defaultImplModel: string;
  defaultReviewModel: string;
  retryLimit: number;
  implTimeoutMinutes: number;
  reviewTimeoutMinutes: number;
}

export type LogPhase =
  | "implement"
  | "review"
  | "retry"
  | "push"
  | "error"
  | "timeout"
  | "abort"
  | "recover";

export interface LogEntry {
  phase: LogPhase;
  content: string;
  createdAt: string;
}

export interface AppConfig {
  redmine: {
    url: string;
    apiKey: string;
  };
  git: {
    repoPath: string;
    baseBranch: string;
    remote: string;
  };
  copilot: {
    command: string;
    extraArgs: string[];
    /** trueの場合、実際のCopilot CLIを起動せずスタブ実装で応答する（ローカル開発・テスト用） */
    mock?: boolean;
  };
  runner: {
    staleThresholdMinutes: number;
    heartbeatIntervalSeconds: number;
    abortPollIntervalSeconds: number;
  };
  /** data/ 以下のファイルを配置するディレクトリ。既定はリポジトリ直下の data/ */
  dataDir?: string;
}

export const AVAILABLE_MODELS = ["gpt-4o", "claude-sonnet", "o4-mini"] as const;
export type ModelName = (typeof AVAILABLE_MODELS)[number];
