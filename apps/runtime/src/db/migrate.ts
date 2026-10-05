import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

/** `apps/runtime/migrations`, resolved from the compiled location of this file. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Arbitrary constant identifying the migration lock. Paired with the schema, so separate schemas do not queue behind each other. */
const ADVISORY_LOCK_KEY = 1_297_044_047;

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/** Checksum over content with line endings normalised, so a CRLF checkout matches an LF one. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Reads migration files and checks they are numbered 0001, 0002, ... with no gaps. */
export async function loadMigrations(directory: string = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.sql')).sort();
  const migrations: MigrationFile[] = [];
  for (const entry of entries) {
    const match = FILE_NAME.exec(entry);
    if (!match) throw new MigrationError(`Migration file "${entry}" must be named NNNN_description.sql`);
    const sql = await readFile(path.join(directory, entry), 'utf8');
    migrations.push({ version: Number(match[1]), name: match[2] ?? '', sql, checksum: migrationChecksum(sql) });
  }
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        `Migration versions must be contiguous from 0001; found ${migration.version} at position ${index + 1}`,
      );
    }
  });
  return migrations;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

async function readApplied(db: pg.ClientBase | pg.Pool): Promise<AppliedRow[]> {
  const exists = await db.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );
  if (!exists.rows[0]?.present) return [];
  const result = await db.query<AppliedRow>('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
  return result.rows;
}

/**
 * Compares what the database has applied with the files on disk. An applied
 * migration that is missing or edited means the schema no longer matches the
 * code's assumptions, which is never safe to ignore.
 */
function pendingAfterVerification(files: readonly MigrationFile[], applied: readonly AppliedRow[]): MigrationFile[] {
  for (const row of applied) {
    const file = files.find((candidate) => candidate.version === row.version);
    if (!file) {
      throw new MigrationError(
        `Database has migration ${row.version} (${row.name}) that this build does not know. Refusing to continue.`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `Migration ${row.version} (${row.name}) was changed after it was applied. ` +
          'Applied migrations are immutable; add a new migration instead.',
      );
    }
  }
  const appliedVersions = new Set(applied.map((row) => row.version));
  return files.filter((file) => !appliedVersions.has(file.version));
}

export interface MigrationStatus {
  readonly applied: number;
  readonly pending: number;
}

export async function getMigrationStatus(pool: pg.Pool, directory?: string): Promise<MigrationStatus> {
  const files = await loadMigrations(directory);
  const applied = await readApplied(pool);
  return { applied: applied.length, pending: pendingAfterVerification(files, applied).length };
}

export interface MigrateResult {
  readonly applied: readonly MigrationFile[];
  readonly alreadyApplied: number;
}

/**
 * Applies pending migrations in order, each in its own transaction. A session
 * advisory lock makes concurrent runs queue up instead of colliding.
 *
 * A migration runs inside a transaction, so statements that cannot (such as
 * CREATE INDEX CONCURRENTLY) are not supported.
 */
export async function migrate(pool: pg.Pool, directory?: string): Promise<MigrateResult> {
  const files = await loadMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1, hashtext(current_schema()))', [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version     integer     PRIMARY KEY,
          name        text        NOT NULL,
          checksum    text        NOT NULL,
          applied_at  timestamptz NOT NULL DEFAULT clock_timestamp()
        )`);
      const applied = await readApplied(client);
      const pending = pendingAfterVerification(files, applied);

      for (const migration of pending) {
        try {
          await client.query('BEGIN');
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
            migration.version,
            migration.name,
            migration.checksum,
          ]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw new MigrationError(`Migration ${migration.version} (${migration.name}) failed and was rolled back`, {
            cause: error,
          });
        }
      }
      return { applied: pending, alreadyApplied: applied.length };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, hashtext(current_schema()))', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
