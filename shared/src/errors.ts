/** APIレイヤーで `{ error: { code, message } }` としてそのまま返せるアプリケーションエラー */
export class AppError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  duplicateTicket: () =>
    new AppError("DUPLICATE_TICKET", "このチケットはすでにキューにあります", 409),
  invalidTicketNo: () =>
    new AppError("INVALID_TICKET_NO", "チケット番号を正しく入力してください", 400),
  ticketNotFound: () =>
    new AppError("TICKET_NOT_FOUND", "指定されたチケットが見つかりません", 404),
  ticketNotWaiting: () =>
    new AppError("TICKET_NOT_WAITING", "待機中のチケットのみ操作できます", 409),
  ticketNotRunning: () =>
    new AppError("TICKET_NOT_RUNNING", "実行中のチケットのみ操作できます", 409),
  ticketRunning: () =>
    new AppError("TICKET_RUNNING", "実行中のチケットは先に中断してから削除してください", 409),
  invalidModel: (name: string) =>
    new AppError("INVALID_MODEL", `対応していないAIモデルです: ${name}`, 400),
};
