import { createApp } from "./app";

const port = Number(process.env.PORT ?? 3000);

/**
 * 既定でループバックのみを待ち受ける。
 * 認証は前段のIISが行い、認証済みユーザー名をX-Remote-Userヘッダーで渡す構成のため、
 * このプロセスへLANから直接到達できるとヘッダーを自称するだけで認証を迂回できてしまう。
 */
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp();

app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`webapp listening on http://${host}:${port}`);
});
