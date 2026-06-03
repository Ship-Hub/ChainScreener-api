import "dotenv/config";
import { buildApp } from "./app.js";
import { env } from "./shared/env.js";

const app = await buildApp();

try {
  await app.listen({ host: env.HOST, port: env.PORT });
  app.log.info(`API listening on ${env.HOST}:${env.PORT}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
