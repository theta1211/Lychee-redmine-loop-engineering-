import type { Request, Response, NextFunction } from "express";

/**
 * Windows統合認証のハンドシェイク自体はIIS側で行う前提。
 * IISの「Windows認証」を有効にしたうえで、URL RewriteのOutbound Rule等を使い、
 * 認証済みユーザー名（LOGON_USER）を X-Remote-User ヘッダーとしてこのアプリへ
 * 転送する構成とする（詳細はdocs/design配下の運用手順を参照）。
 *
 * ローカル開発時はヘッダーの代わりに環境変数 DEVLOOP_DEV_USER で代用できる。
 */
export function resolveUser(req: Request): string | undefined {
  const header = req.header("x-remote-user");
  if (header) return header;
  return process.env.DEVLOOP_DEV_USER;
}

export interface AuthedRequest extends Request {
  user?: string;
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  const user = resolveUser(req);
  if (!user) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "認証情報が見つかりません" } });
    return;
  }
  (req as AuthedRequest).user = user;
  next();
}
