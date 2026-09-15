import { runOnce } from "./runOnce";

runOnce()
  .then((result) => {
    // eslint-disable-next-line no-console
    console.log(`[devloop-engine] ${JSON.stringify(result)}`);
    process.exit(0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[devloop-engine] unexpected failure", err);
    process.exit(1);
  });
