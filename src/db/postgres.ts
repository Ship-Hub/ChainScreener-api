import postgres from "postgres";
import { env } from "../shared/env.js";

let _sql: ReturnType<typeof postgres> | undefined;

export function getDb() {
  if (!_sql) {
    _sql = postgres(env.DATABASE_URL, {
      max:             10,
      idle_timeout:    30,
      connect_timeout: 10,
      // Silence "already exists" PostgreSQL notices from idempotent migrations
      onnotice: (n) => {
        if (n.code === "42P07" || n.code === "42710") return; // relation/object already exists
        console.warn("[pg]", n.message);
      },
    });
  }
  return _sql;
}

export async function closeDb() {
  if (!_sql) return;
  await _sql.end();
  _sql = undefined;
}
