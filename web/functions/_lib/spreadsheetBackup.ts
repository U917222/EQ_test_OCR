export const D1_SPREADSHEET_BACKUP_VERSION = "d1-spreadsheet-backup/v1" as const;

export type SpreadsheetBackupCell = string | number | boolean | null;

export interface SpreadsheetBackupSheet {
  name: string;
  table: string;
  columns: string[];
  values: SpreadsheetBackupCell[][];
  rowCount: number;
  jsonColumns: string[];
}

export interface SpreadsheetBackup {
  schemaVersion: typeof D1_SPREADSHEET_BACKUP_VERSION;
  exportedAt: string;
  source: {
    kind: "cloudflare-d1";
    binding: string;
  };
  sheets: SpreadsheetBackupSheet[];
}

export interface ExportD1SpreadsheetBackupOptions {
  exportedAt?: string;
  bindingName?: string;
  tables?: readonly D1BackupTableName[];
}

interface TableSpec {
  table: D1BackupTableName;
  sheetName: string;
  orderBy: string;
  jsonColumns?: readonly string[];
}

export const D1_BACKUP_TABLES = [
  "users",
  "candidates",
  "candidate_files",
  "candidate_file_chunks",
  "raw_cells",
  "review_queue",
  "results",
  "api_operations",
  "api_nonces",
  "audit_log",
  "item_master",
  "score_bands",
  "rank_rules",
  "handwritten_totals",
] as const;

export type D1BackupTableName = (typeof D1_BACKUP_TABLES)[number];

const TABLE_SPECS: readonly TableSpec[] = [
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

const TABLE_SPEC_BY_NAME = new Map(TABLE_SPECS.map((spec) => [spec.table, spec]));

export async function exportD1ToSpreadsheetBackup(
  db: D1Database,
  options: ExportD1SpreadsheetBackupOptions = {},
): Promise<SpreadsheetBackup> {
  const selectedTables = options.tables ?? D1_BACKUP_TABLES;
  const sheets = await Promise.all(selectedTables.map((table) => exportTable(db, requireTableSpec(table))));

  return {
    schemaVersion: D1_SPREADSHEET_BACKUP_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    source: {
      kind: "cloudflare-d1",
      binding: options.bindingName ?? "CHEQ_DB",
    },
    sheets,
  };
}

async function exportTable(db: D1Database, spec: TableSpec): Promise<SpreadsheetBackupSheet> {
  const columns = await readColumns(db, spec.table);
  const rows = await db.prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.orderBy}`).all<Record<string, unknown>>();
  const values = [
    columns,
    ...rows.results.map((row) => columns.map((column) => toSpreadsheetCell(row[column]))),
  ];

  return {
    name: spec.sheetName,
    table: spec.table,
    columns,
    values,
    rowCount: rows.results.length,
    jsonColumns: [...(spec.jsonColumns ?? [])],
  };
}

async function readColumns(db: D1Database, table: D1BackupTableName): Promise<string[]> {
  const rows = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string; cid: number }>();
  return rows.results
    .slice()
    .sort((left, right) => left.cid - right.cid)
    .map((row) => row.name);
}

function requireTableSpec(table: D1BackupTableName): TableSpec {
  const spec = TABLE_SPEC_BY_NAME.get(table);
  if (!spec) {
    throw new Error(`Unsupported D1 backup table: ${table}`);
  }
  return spec;
}

function toSpreadsheetCell(value: unknown): SpreadsheetBackupCell {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  return JSON.stringify(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
