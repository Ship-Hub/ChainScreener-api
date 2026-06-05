import "dotenv/config";
import { buildApp } from "./app.js";
import { env } from "./shared/env.js";
import { startIndexerLoop } from "./indexer/indexerLoop.js";

const app = await buildApp();

try {
  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info(`API listening on ${env.HOST}:${env.PORT}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

if (env.ENABLE_INDEXER) {
  app.log.info("[indexer] ENABLE_INDEXER=true — starting background indexer loop");
  const runLoop = () => {
    startIndexerLoop((msg) => app.log.info(msg)).catch((error) => {
      app.log.error({ err: error }, "[indexer] Loop crashed — restarting in 10s");
      setTimeout(runLoop, 10_000);
    });
  };
  runLoop();
}
