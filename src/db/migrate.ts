import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chains } from "../config/chains.js";
import { dexes } from "../config/dexes.js";
import { closeDb, getDb } from "./postgres.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(__dirname, "../../db/schema.sql");

/**
 * Split a SQL file into individual statements, respecting:
 * - $$ dollar-quoted blocks (used in TimescaleDB/PL/pgSQL)
 * - Single-quoted string literals
 * - Semicolons as statement terminators
 */
function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDollarQuote = false;
  let dollarTag = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    if (inDollarQuote) {
      // Look for matching closing dollar tag
      if (ch === "$") {
        const end = sql.indexOf("$", i + 1);
        if (end !== -1) {
          const tag = sql.slice(i, end + 1);
          if (tag === dollarTag) {
            current += tag;
            i = end + 1;
            inDollarQuote = false;
            dollarTag = "";
            continue;
          }
        }
      }
      current += ch;
      i++;
      continue;
    }

    if (inSingleQuote) {
      if (ch === "'" && sql[i + 1] === "'") {
        current += "''";
        i += 2;
        continue;
      }
      if (ch === "'") {
        inSingleQuote = false;
      }
      current += ch;
      i++;
      continue;
    }

    // Not inside any quote
    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      i++;
      continue;
    }

    if (ch === "$") {
      // Check for dollar-quoting tag like $$ or $tag$
      const end = sql.indexOf("$", i + 1);
      if (end !== -1) {
        const tag = sql.slice(i, end + 1);
        if (/^\$[A-Za-z_]*\$$/.test(tag)) {
          inDollarQuote = true;
          dollarTag = tag;
          current += tag;
          i = end + 1;
          continue;
        }
      }
    }

    if (ch === "-" && sql[i + 1] === "-") {
      // Line comment — skip to end of line
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }

    if (ch === ";") {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const last = current.trim();
  if (last) statements.push(last);

  return statements;
}

export async function runMigration() {
  const sql = getDb();
  const schema = await fs.readFile(schemaPath, "utf8");
  const statements = splitSql(schema);

  for (const stmt of statements) {
    try {
      await sql.unsafe(stmt);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Ignore "already exists" style errors — idempotent migration
      if (
        msg.includes("already exists") ||
        msg.includes("duplicate") ||
        msg.includes("already have") ||
        msg.includes("relation") && msg.includes("does not exist")
      ) {
        console.warn(`[migrate] skipped (already exists): ${stmt.slice(0, 80)}...`);
        continue;
      }
      // Re-throw unexpected errors
      throw new Error(`[migrate] Failed statement:\n${stmt}\n\nError: ${msg}`);
    }
  }

  // Seed chains
  for (const chain of Object.values(chains)) {
    await sql`
      INSERT INTO chains ("key", name, chain_id, native_symbol, rpc_url)
      VALUES (${chain.key}, ${chain.name}, ${chain.chainId}, ${chain.nativeSymbol}, ${chain.rpcUrl})
      ON CONFLICT ("key") DO UPDATE
        SET name          = EXCLUDED.name,
            native_symbol = EXCLUDED.native_symbol,
            rpc_url       = EXCLUDED.rpc_url
    `;
  }

  // Seed dexes
  for (const dex of dexes) {
    await sql`
      INSERT INTO dexes (chain_id, "key", name, protocol_version, factory_address, event_name)
      SELECT chains.id, ${dex.key}, ${dex.name}, ${dex.version}, ${dex.factoryAddress.toLowerCase()}, ${dex.event}
      FROM chains
      WHERE chains."key" = ${dex.chain}
      ON CONFLICT ("key") DO UPDATE
        SET name             = EXCLUDED.name,
            protocol_version = EXCLUDED.protocol_version,
            factory_address  = EXCLUDED.factory_address,
            event_name       = EXCLUDED.event_name
    `;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigration()
    .then(async () => {
      await closeDb();
      console.log("PostgreSQL schema migrated and chain/DEX config seeded.");
    })
    .catch(async (error) => {
      await closeDb();
      console.error(error);
      process.exitCode = 1;
    });
}
