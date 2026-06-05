import { closeDb } from "../db/postgres.js";
import { runMigration } from "../db/migrate.js";
import { generateAlertsOnce } from "../services/alerts.js";

if (process.argv[1]?.endsWith("generateAlerts.ts") || process.argv[1]?.endsWith("generateAlerts.js")) {
  runMigration()
    .then(() => generateAlertsOnce())
    .then(async (result) => {
      console.log(`Generated alerts: ${result.created}/${result.checked} tokens checked.`);
      await closeDb();
    })
    .catch(async (error) => {
      console.error(error);
      await closeDb();
      process.exitCode = 1;
    });
}
