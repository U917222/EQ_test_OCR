#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BACKUP_VERSION = "d1-spreadsheet-backup/v1";
const DEFAULT_DATABASE = "cheq-eqtest";

const TABLE_SPECS = [
  { table: "users", sheetName: "users", orderBy: "email" },
  { table: "candidates", sheetName: "candidates", orderBy: "uploaded_at, candidate_id" },
  { table: "candidate_files", sheetName: "candidate_files", orderBy: "uploaded_at, file_id" },
  { table: "candidate_file_chunks", sheetName: "candidate_file_chunks", orderBy: "file_id, chunk_index" },
  { table: "raw_cells", sheetName: "raw_cells", orderBy: "candidate_id", jsonColumns: ["cells_json", "image_links_json"] },
  { table: "review_queue", sheetName: "review_queue", orderBy: "candidate_id, cell_key, review_id" },
  {
    table: "results",
    sheetName: "results",
    orderBy: "candidate_id",
    jsonColumns: ["job_requirement_low_items_json", "row_scores_json", "item_totals_json", "item_stages_json", "cross_check_json"],
  },
  { table: "api_operations", sheetName: "api_operations", orderBy: "created_at, operation_id", jsonColumns: ["result_json"] },
  { table: "api_nonces", sheetName: "api_nonces", orderBy: "ts, nonce" },
  { table: "audit_log", sheetName: "audit_log", orderBy: "audit_id", jsonColumns: ["detail_json"] },
  { table: "item_master", sheetName: "item_master", orderBy: "display_order, item_key" },
  { table: "score_bands", sheetName: "score_bands", orderBy: "item_key, min_score, max_score" },
  { table: "rank_rules", sheetName: "rank_rules", orderBy: "rule_id", jsonColumns: ["condition_json"] },
  { table: "handwritten_totals", sheetName: "handwritten_totals", orderBy: "candidate_id, item_key" },
];

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const database = args.database ?? DEFAULT_DATABASE;
  const tables = args.tables.length > 0 ? TABLE_SPECS.filter((spec) => args.tables.includes(spec.table)) : TABLE_SPECS;
  const unknownTables = args.tables.filter((table) => !TABLE_SPECS.some((spec) => spec.table === table));

  if (unknownTables.length > 0) {
    throw new Error(`Unknown table(s): ${unknownTables.join(", ")}`);
  }

  const backup = {
    schemaVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      kind: "cloudflare-d1",
      database,
      mode: args.remote ? "remote" : "local",
    },
    sheets: tables.map((spec) => exportTable(database, spec, args.remote)),
  };

  const output = `${JSON.stringify(backup, null, 2)}\n`;
  if (args.output) {
    writeFileSync(args.output, output);
  } else {
    process.stdout.write(output);
  }
}

function exportTable(database, spec, remote) {
  const columns = query(database, `PRAGMA table_info(${spec.table})`, remote)
    .sort((left, right) => Number(left.cid) - Number(right.cid))
    .map((row) => row.name);
  const rows = query(database, `SELECT * FROM ${spec.table} ORDER BY ${spec.orderBy}`, remote);

  return {
    name: spec.sheetName,
    table: spec.table,
    columns,
    values: [
      columns,
      ...rows.map((row) => columns.map((column) => toSpreadsheetCell(row[column]))),
    ],
    rowCount: rows.length,
    jsonColumns: spec.jsonColumns ?? [],
  };
}

function query(database, sql, remote) {
  const commandArgs = ["exec", "wrangler", "d1", "execute", database, "--command", sql, "--json"];
  if (remote) commandArgs.push("--remote");
  const wranglerLogPath = join(process.cwd(), ".wrangler", "logs");
  mkdirSync(wranglerLogPath, { recursive: true });

  const result = spawnSync("pnpm", commandArgs, {
    encoding: "utf8",
    env: { ...process.env, WRANGLER_LOG_PATH: wranglerLogPath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(wranglerErrorMessage(result.stdout, result.stderr, result.status));
  }

  return extractRows(parseWranglerJson(result.stdout));
}

function extractRows(payload) {
  const statement = Array.isArray(payload) ? payload[0] : payload;
  if (Array.isArray(statement?.results)) return statement.results;
  if (Array.isArray(statement?.result?.[0]?.results)) return statement.result[0].results;
  if (Array.isArray(statement?.result?.results)) return statement.result.results;
  return [];
}

function toSpreadsheetCell(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function wranglerErrorMessage(stdout, stderr, status) {
  const parsed = parseWranglerJson(stdout, false);
  const text = parsed?.error?.text;
  if (text) return text;
  return stderr || stdout || `wrangler exited with status ${status}`;
}

function parseWranglerJson(stdout, throwOnFailure = true) {
  try {
    return JSON.parse(stdout);
  } catch {
    const text = stripAnsi(stdout).trim();
    const lines = text.split(/\r?\n/);
    for (let start = 0; start < lines.length; start += 1) {
      const first = lines[start].trimStart();
      if (!first.startsWith("{") && !first.startsWith("[")) continue;

      for (let end = lines.length; end > start; end -= 1) {
        try {
          return JSON.parse(lines.slice(start, end).join("\n"));
        } catch {
          // Keep looking for the JSON payload inside Wrangler's mixed output.
        }
      }
    }

    if (throwOnFailure) throw new Error(`Unable to parse wrangler JSON output: ${text}`);
    return null;
  }
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseArgs(argv) {
  const parsed = {
    database: undefined,
    output: undefined,
    remote: false,
    tables: [],
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--remote") {
      parsed.remote = true;
    } else if (arg === "--database") {
      parsed.database = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--output") {
      parsed.output = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--tables") {
      parsed.tables = requireValue(argv, index, arg)
        .split(",")
        .map((table) => table.trim())
        .filter(Boolean);
      index += 1;
    } else if (!arg.startsWith("-") && !parsed.database) {
      parsed.database = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp() {
  process.stdout.write(`Export Cloudflare D1 tables to spreadsheet-shaped JSON.

Usage:
  pnpm exec node scripts/export-d1-spreadsheet-backup.mjs [database] [options]

Options:
  --database <name>       D1 database name. Defaults to ${DEFAULT_DATABASE}.
  --remote                Export from the remote Cloudflare D1 database.
  --tables <a,b,c>        Comma-separated table allowlist.
  --output <file>         Write JSON to a file instead of stdout.
  -h, --help              Show this help.

Example:
  pnpm exec node scripts/export-d1-spreadsheet-backup.mjs --remote --output backup.json
`);
}
