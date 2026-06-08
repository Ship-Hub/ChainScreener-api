import type { FastifyInstance } from "fastify";
import { env } from "../shared/env.js";
import { getLiveFeedSnapshot } from "../services/liveFeed.js";

function resolveCorsOrigin(origin: string | undefined) {
  if (env.FRONTEND_ORIGIN === "*") return "*";
  const allowed = env.FRONTEND_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) return origin;
  return allowed[0] ?? "*";
}

function writeSseEvent(raw: NodeJS.WritableStream, event: string, data: unknown) {
  raw.write(`event: ${event}\n`);
  raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function registerLiveRoutes(app: FastifyInstance) {
  app.get("/api/live/stream", async (request, reply) => {
    const corsOrigin = resolveCorsOrigin(request.headers.origin);

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": corsOrigin,
      Vary: "Origin",
      "X-Accel-Buffering": "no",
    });

    reply.raw.write(`retry: ${Math.max(1000, env.LIVE_FEED_INTERVAL_MS)}\n\n`);

    let closed = false;
    let sending = false;

    const sendSnapshot = async () => {
      if (closed || sending) return;
      sending = true;
      try {
        const snapshot = await getLiveFeedSnapshot();
        if (!closed) writeSseEvent(reply.raw, "snapshot", snapshot);
      } catch (error) {
        if (!closed) {
          writeSseEvent(reply.raw, "error", {
            message: error instanceof Error ? error.message : String(error),
            emittedAt: new Date().toISOString(),
          });
        }
      } finally {
        sending = false;
      }
    };

    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, 25_000);

    const interval = setInterval(sendSnapshot, env.LIVE_FEED_INTERVAL_MS);
    void sendSnapshot();

    reply.raw.on("close", () => {
      closed = true;
      clearInterval(interval);
      clearInterval(heartbeat);
    });
  });
}
