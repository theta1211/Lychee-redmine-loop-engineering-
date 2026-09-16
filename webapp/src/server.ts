import { createApp } from "./app";

const app = createApp();

// iisnode配下では process.env.PORT に名前付きパイプのパスが入り、
// listen()にホストを渡すとその名前付きパイプ待受と衝突するため渡さない。
// Windows認証・匿名認証の無効化はIIS側（webapp/web.config）で行う。
const isIisNode = !!process.env.IISNODE_VERSION;

if (isIisNode) {
  app.listen(process.env.PORT as unknown as number, () => {
    // eslint-disable-next-line no-console
    console.log(`webapp listening under iisnode (pipe: ${process.env.PORT})`);
  });
} else {
  /**
   * 単体起動時（ローカル開発・動作確認）は既定でループバックのみを待ち受ける。
   * 認証は前段のIISが行い、認証済みユーザー名をX-Remote-Userヘッダーで渡す構成のため、
   * このプロセスへLANから直接到達できるとヘッダーを自称するだけで認証を迂回できてしまう。
   */
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  app.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`webapp listening on http://${host}:${port}`);
  });
}
