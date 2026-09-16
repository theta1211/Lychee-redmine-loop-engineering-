import express, { Express, Request, Response } from "express";
import * as path from "node:path";
import {
  loadConfig,
  addTicket,
  getQueue,
  updateOrder,
  updateModels,
  deleteTicket,
  requestAbort,
  setPaused,
  queueItems,
  historyItems,
  getSettings,
  updateSettings,
  readLogs,
  deleteLogs,
  createRedmineClient,
  RedmineNotFoundError,
  RedmineUnavailableError,
  RedmineClient,
  AppError,
  AVAILABLE_MODELS,
  type AppConfig,
} from "@devloop/shared";
import { requireUser, type AuthedRequest } from "./auth";

function sendError(res: Response, err: unknown): void {
  if (err instanceof AppError) {
    res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof RedmineNotFoundError) {
    res.status(404).json({ error: { code: "REDMINE_NOT_FOUND", message: err.message } });
    return;
  }
  if (err instanceof RedmineUnavailableError) {
    res.status(503).json({ error: { code: "REDMINE_UNAVAILABLE", message: err.message } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL", message: "予期しないエラーが発生しました" } });
}

function validateModel(name: unknown): void {
  if (name === null || name === undefined || name === "") return;
  if (!AVAILABLE_MODELS.includes(name as (typeof AVAILABLE_MODELS)[number])) {
    throw new AppError("INVALID_MODEL", `対応していないAIモデルです: ${name}`);
  }
}

/**
 * 未指定（空文字）は「デフォルトを使う」を意味するnullへ寄せる。
 * キー自体が無い場合のundefinedは「変更しない」として保持する。
 */
function normalizeModel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return (value as string) || null;
}

function settingsResponse(settings: Awaited<ReturnType<typeof getSettings>>, config: AppConfig) {
  return {
    ...settings,
    reference: {
      redmineUrl: config.redmine.url,
      targetRepoPath: config.git.repoPath,
      baseBranch: config.git.baseBranch,
    },
  };
}

export interface CreateAppOptions {
  config?: AppConfig;
  redmineClient?: RedmineClient;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const config = options.config ?? loadConfig();
  const dataDir = config.dataDir!;
  const redmine = options.redmineClient ?? createRedmineClient(config.redmine);

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));
  app.use("/api", requireUser);

  app.get("/api/queue", async (req: Request, res: Response) => {
    const scope = (req.query.scope as string) ?? "queue";
    const q = await getQueue(dataDir);
    const items = scope === "history" ? historyItems(q) : scope === "all" ? q.items : queueItems(q);
    res.json({
      queuePaused: q.queuePaused,
      runner: q.runner,
      abortRequestedTicketId: q.abortRequestedTicketId,
      items: items.map((t) => ({ ...t, abortRequested: q.abortRequestedTicketId === t.id })),
    });
  });

  app.post("/api/queue", async (req: AuthedRequest, res: Response) => {
    try {
      const { redmineTicketNo, implModel, reviewModel } = req.body ?? {};
      if (!redmineTicketNo || !/^\d+$/.test(String(redmineTicketNo))) {
        throw new AppError("INVALID_TICKET_NO", "チケット番号を正しく入力してください");
      }
      validateModel(implModel);
      validateModel(reviewModel);
      const issue = await redmine.getIssue(String(redmineTicketNo));
      const ticket = await addTicket(dataDir, {
        redmineTicketNo: String(redmineTicketNo),
        title: issue.subject,
        implModel: implModel || null,
        reviewModel: reviewModel || null,
        registeredBy: req.user!,
      });
      res.status(201).json(ticket);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.put("/api/queue/:id/order", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const newIndex = Number(req.body?.newIndex);
      const q = await updateOrder(dataDir, id, newIndex);
      res.json({
        queuePaused: q.queuePaused,
        runner: q.runner,
        abortRequestedTicketId: q.abortRequestedTicketId,
        items: queueItems(q),
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.put("/api/queue/:id/models", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const { implModel, reviewModel } = req.body ?? {};
      validateModel(implModel);
      validateModel(reviewModel);
      const ticket = await updateModels(dataDir, id, {
        implModel: normalizeModel(implModel),
        reviewModel: normalizeModel(reviewModel),
      });
      res.json(ticket);
    } catch (err) {
      sendError(res, err);
    }
  });

  app.delete("/api/queue/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await deleteTicket(dataDir, id);
      await deleteLogs(dataDir, id);
      res.status(204).end();
    } catch (err) {
      sendError(res, err);
    }
  });

  app.post("/api/queue/:id/abort", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      await requestAbort(dataDir, id);
      res.status(202).json({ accepted: true, ticketId: id });
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/queue/:id/logs", async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const logs = await readLogs(dataDir, id);
    res.json({ ticketId: id, logs });
  });

  app.post("/api/queue/pause", async (_req: Request, res: Response) => {
    const q = await setPaused(dataDir, true);
    res.json({ queuePaused: q.queuePaused });
  });

  app.post("/api/queue/resume", async (_req: Request, res: Response) => {
    const q = await setPaused(dataDir, false);
    res.json({ queuePaused: q.queuePaused });
  });

  app.get("/api/settings", async (_req: Request, res: Response) => {
    const settings = await getSettings(dataDir);
    res.json(settingsResponse(settings, config));
  });

  app.put("/api/settings", async (req: Request, res: Response) => {
    try {
      const settings = await updateSettings(dataDir, req.body ?? {});
      res.json(settingsResponse(settings, config));
    } catch (err) {
      sendError(res, err);
    }
  });

  app.get("/api/whoami", (req: AuthedRequest, res: Response) => {
    res.json({ user: req.user });
  });

  return app;
}
