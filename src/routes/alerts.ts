import type { FastifyInstance } from "fastify";
import { generateAlertsOnce, getAlertCounts, listAlerts } from "../services/alerts.js";

export async function registerAlertRoutes(app: FastifyInstance) {
  app.get("/api/alerts", async (request) => {
    const query = request.query as { limit?: string };
    return { data: await listAlerts(Number(query.limit ?? 50)) };
  });

  app.get("/api/alerts/counts", async () => ({ data: await getAlertCounts() }));

  app.post("/api/alerts/generate", async () => ({ data: await generateAlertsOnce() }));
}
