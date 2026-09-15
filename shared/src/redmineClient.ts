import axios, { AxiosInstance } from "axios";
import type { AppConfig } from "./types";

export interface RedmineIssue {
  id: string;
  subject: string;
  description: string;
  status: string;
}

export class RedmineNotFoundError extends Error {}
export class RedmineUnavailableError extends Error {}

export function createRedmineClient(config: AppConfig["redmine"]) {
  const client: AxiosInstance = axios.create({
    baseURL: config.url,
    headers: { "X-Redmine-API-Key": config.apiKey },
    timeout: 15000,
  });

  async function getIssue(ticketNo: string): Promise<RedmineIssue> {
    try {
      const res = await client.get(`/issues/${ticketNo}.json`);
      const issue = res.data.issue;
      return {
        id: String(issue.id),
        subject: issue.subject,
        description: issue.description ?? "",
        status: issue.status?.name ?? "",
      };
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 404) {
        throw new RedmineNotFoundError(`チケット #${ticketNo} がRedmine上に見つかりません`);
      }
      throw new RedmineUnavailableError(`Redmineへの接続に失敗しました: ${(err as Error).message}`);
    }
  }

  async function addComment(ticketNo: string, notes: string): Promise<void> {
    try {
      await client.put(`/issues/${ticketNo}.json`, { issue: { notes } });
    } catch (err) {
      throw new RedmineUnavailableError(`Redmineへのコメント登録に失敗しました: ${(err as Error).message}`);
    }
  }

  return { getIssue, addComment };
}

export type RedmineClient = ReturnType<typeof createRedmineClient>;
