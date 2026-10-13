import type { Queryable } from './pool.js';

/**
 * The column that says when a row was added, per table. Growth is measured
 * from it. A table listed with null is a mutable projection or a log too
 * small to matter; its growth is reported as unknown, never as zero.
 *
 * Every table in the schema must be listed (a test checks this), so a new
 * table cannot silently go unmeasured.
 */
export const STORAGE_TIME_COLUMNS: Readonly<Record<string, string | null>> = {
  raw_payloads: 'first_stored_at',
  raw_observations: 'available_at',
  events: 'available_at',
  parse_quarantine: 'quarantined_at',
  event_conflicts: 'detected_at',
  jobs: 'created_at',
  consumer_inbox: 'processed_at',
  audit_log: 'occurred_at',
  quota_events: 'occurred_at',
  provider_probes: 'probed_at',
  run_sessions: 'started_at',
  session_gaps: 'detected_at',
  source_health: null,
  quota_counters: null,
  schema_migrations: null,
};

export interface TableStorage {
  readonly table: string;
  readonly rows: number;
  /** Table, indexes and TOAST together. */
  readonly totalBytes: number;
  /** Rows added in the last 24 hours; null when the table has no time column. */
  readonly rowsLastDay: number | null;
  /**
   * Bytes added in the last 24 hours, estimated as rows added times the
   * table's current bytes per row. Null when unknown.
   */
  readonly bytesLastDay: number | null;
}

export interface StorageReport {
  readonly measuredAt: Date;
  readonly databaseBytes: number;
  /** Largest first. */
  readonly tables: readonly TableStorage[];
  /**
   * Growth in the last 24 hours of the tables whose growth is known. It is
   * not the database's total: `unknownGrowth` names the tables left out.
   * Null when no table's growth is known.
   */
  readonly knownBytesLastDay: number | null;
  /** Tables whose growth is unknown, so not part of `knownBytesLastDay`. */
  readonly unknownGrowth: readonly string[];
}

/**
 * Measures every table in the current schema. Each table is scanned once to
 * count its rows, so this is for an operator asking, not for a polled
 * endpoint: on a large database it can take a while.
 */
export async function measureStorage(db: Queryable): Promise<StorageReport> {
  const found = await db.query<{ table: string; total_bytes: string }>(
    `SELECT c.relname AS table, pg_total_relation_size(c.oid)::text AS total_bytes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
  );
  const tables: TableStorage[] = [];
  for (const { table, total_bytes } of found.rows) {
    const timeColumn = STORAGE_TIME_COLUMNS[table] ?? null;
    // Identifiers come from pg_class and the fixed map above, never from input.
    const counted = await db.query<{ rows: string; recent: string | null }>(
      timeColumn === null
        ? `SELECT count(*)::text AS rows, NULL AS recent FROM "${table}"`
        : `SELECT count(*)::text AS rows,
                  (count(*) FILTER (WHERE "${timeColumn}" >= clock_timestamp() - interval '24 hours'))::text AS recent
             FROM "${table}"`,
    );
    const rows = Number(counted.rows[0]?.rows ?? 0);
    const recent = counted.rows[0]?.recent;
    const rowsLastDay = recent === null || recent === undefined ? null : Number(recent);
    const totalBytes = Number(total_bytes);
    const bytesLastDay = rowsLastDay === null ? null : rows === 0 ? 0 : Math.round((rowsLastDay * totalBytes) / rows);
    tables.push({ table, rows, totalBytes, rowsLastDay, bytesLastDay });
  }
  tables.sort((a, b) => b.totalBytes - a.totalBytes || a.table.localeCompare(b.table));

  const database = await db.query<{ bytes: string; now: Date }>(
    'SELECT pg_database_size(current_database())::text AS bytes, clock_timestamp() AS now',
  );
  const known = tables.filter((table) => table.bytesLastDay !== null);
  return {
    measuredAt: database.rows[0]?.now ?? new Date(),
    databaseBytes: Number(database.rows[0]?.bytes ?? 0),
    tables,
    knownBytesLastDay: known.length === 0 ? null : known.reduce((sum, table) => sum + (table.bytesLastDay ?? 0), 0),
    unknownGrowth: tables
      .filter((table) => table.bytesLastDay === null)
      .map((table) => table.table)
      .sort(),
  };
}

/** 1536 -> "1.5 KB". Binary units, one decimal from KB up. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** The report as a plain-text table for the terminal. */
export function formatStorageReport(report: StorageReport): string {
  const header = ['table', 'rows', 'size', 'rows/24h', 'growth/24h'];
  const body = report.tables.map((table) => [
    table.table,
    String(table.rows),
    formatBytes(table.totalBytes),
    table.rowsLastDay === null ? '?' : String(table.rowsLastDay),
    table.bytesLastDay === null ? '?' : formatBytes(table.bytesLastDay),
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...body.map((row) => (row[column] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0))).join('  ');
  const daily = report.knownBytesLastDay;
  const unknown = report.unknownGrowth;
  // A sum that leaves tables out says so, and names them: unknown is not zero.
  const growth =
    daily === null
      ? 'Growth in the last 24 hours: unknown for every table.'
      : unknown.length === 0
        ? `Growth in the last 24 hours: ${formatBytes(daily)}; at that rate, ${formatBytes(daily * 30)} per 30 days.`
        : `Growth in the last 24 hours, tables with known growth only: ${formatBytes(daily)}; at that rate, ` +
          `${formatBytes(daily * 30)} per 30 days. Not included (growth unknown): ${unknown.join(', ')}.`;
  return [
    line(header),
    ...body.map(line),
    '',
    `Database total: ${formatBytes(report.databaseBytes)} (measured ${report.measuredAt.toISOString()})`,
    growth,
    '"?" means the table has no time column, so its growth is unknown.',
  ].join('\n');
}
