import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { createPool } from './pool.js';

/*
 * Backups (FT-06). `createBackup` writes a pg_dump of one schema to a folder
 * outside the repository, with a manifest of what the dump must contain: the
 * row count of every table, the append-only triggers and the applied
 * migrations, all read in the same snapshot pg_dump uses. `checkRestore`
 * restores it into a separate database, `<database>_restore_check`, and
 * compares. A backup that has never been restored is a hope, not a backup.
 *
 * The restore never touches the database that was backed up: its target name
 * is derived, always ends in `_restore_check`, and is checked again on the
 * open connection before anything is dropped.
 */

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

/** A PostgreSQL client tool is not on PATH. */
export class ToolNotFoundError extends BackupError {
  constructor(readonly tool: string) {
    super(`${tool} was not found. Put the PostgreSQL client tools on PATH (scripts\\dev-env.ps1 does).`);
    this.name = 'ToolNotFoundError';
  }
}

/** The repository root, from the compiled location of this file (apps/runtime/dist/db). */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const RESTORE_CHECK_SUFFIX = '_restore_check';
const MANIFEST_FORMAT = 'morrow-backup@1';

export interface BackupManifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly created_at: string;
  readonly database: string;
  readonly schema: string;
  readonly server_version: string;
  /** pg_restore must be at least this new. */
  readonly server_major: number;
  readonly pg_dump_version: string;
  /** File name of the dump, next to this manifest. */
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Row count of every table in the schema, in the dump's snapshot. */
  readonly tables: Readonly<Record<string, number>>;
  /** Trigger names in the schema, sorted. The append-only guards are among them. */
  readonly triggers: readonly string[];
  readonly migrations: readonly { readonly version: number; readonly name: string; readonly checksum: string }[];
  /** Added by a restore check that passed. A manifest without it describes a backup nobody has restored. */
  readonly restore_check?: { readonly passed_at: string; readonly database: string };
}

export interface CreatedBackup {
  readonly file: string;
  readonly manifestFile: string;
  readonly manifest: BackupManifest;
}

export interface RestoreCheck {
  readonly database: string;
  readonly tables: number;
  readonly rows: number;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The database a backup of `database` is restored into for checking. */
export function restoreCheckDatabaseName(database: string): string {
  if (database.endsWith(RESTORE_CHECK_SUFFIX)) {
    throw new BackupError(`"${database}" is itself a restore check database; it is not backed up`);
  }
  return `${database}${RESTORE_CHECK_SUFFIX}`;
}

/** The backup folder must be absolute and outside the repository, where `git clean` cannot reach it. */
export function assertBackupDir(dir: string): void {
  if (!path.isAbsolute(dir)) throw new BackupError(`MORROW_BACKUP_DIR must be an absolute path, not "${dir}"`);
  const relative = path.relative(REPO_ROOT, path.resolve(dir));
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new BackupError('MORROW_BACKUP_DIR must be outside the repository');
  }
}

export function databaseName(connectionString: string): string {
  return decodeURIComponent(new URL(connectionString).pathname.slice(1));
}

function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

/**
 * Environment for pg_dump and pg_restore. The connection goes in PG*
 * variables, not on the command line, so the password never appears in a
 * process list. PG* variables inherited from the shell are dropped, so none
 * of them can point the tools somewhere else.
 */
export function pgToolEnv(connectionString: string, database?: string): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new BackupError('The database URL is not a postgres:// URL');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('PG')) env[key] = value;
  env['PGHOST'] = url.searchParams.get('host') ?? (url.hostname || 'localhost');
  env['PGPORT'] = url.port || '5432';
  env['PGUSER'] = decodeURIComponent(url.username);
  if (url.password) env['PGPASSWORD'] = decodeURIComponent(url.password);
  env['PGDATABASE'] = database ?? databaseName(connectionString);
  env['PGCONNECT_TIMEOUT'] = '10';
  return env;
}

/**
 * Whether an archive's table of contents (`pg_restore --list`) creates
 * `schema` itself. A listing line reads `4; 2615 2200 SCHEMA - public owner`.
 * pg_dump leaves `public` out when it dumps a whole database, as a schema
 * every new database already has; selected with --schema, it may be listed.
 */
export function archiveCreatesSchema(listing: string, schema: string): boolean {
  return listing.split(/\r?\n/).some((line) => /^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+(\S+)\s/.exec(line)?.[1] === schema);
}

/** The major version in `pg_dump --version` output, for example 17 in "pg_dump (PostgreSQL) 17.6". */
export function parseToolMajor(output: string): number | null {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(output);
  return match?.[1] ? Number(match[1]) : null;
}

function runTool(command: string, args: readonly string[], env: NodeJS.ProcessEnv, redact: (text: string) => string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT' ? new ToolNotFoundError(command) : error);
    });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new BackupError(`${command} failed (exit ${code}): ${redact(stderr.trim())}`));
    });
  });
}

/** What `tool --version` prints, for example "pg_dump (PostgreSQL) 17.6"; null when the tool is not on PATH. */
export async function toolVersion(tool: string): Promise<string | null> {
  try {
    return (await runTool(tool, ['--version'], process.env, (text) => text)).trim();
  } catch (error) {
    if (error instanceof ToolNotFoundError) return null;
    throw error;
  }
}

/** Fails unless `tool` is at least as new as the server: an older pg_dump refuses a newer server, or misses what it added. */
async function assertToolVersion(tool: string, serverMajor: number, env: NodeJS.ProcessEnv, redact: (text: string) => string): Promise<string> {
  const output = (await runTool(tool, ['--version'], env, redact)).trim();
  const major = parseToolMajor(output);
  if (major === null || major < serverMajor) {
    throw new BackupError(
      `${output || tool} cannot handle a PostgreSQL ${serverMajor} server. Put the PostgreSQL ${serverMajor} client tools first on PATH.`,
    );
  }
  return output;
}

async function digest(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** What a schema contains, as the manifest records it. */
async function describeSchema(
  db: pg.Pool | pg.PoolClient,
  schema: string,
): Promise<Pick<BackupManifest, 'tables' | 'triggers' | 'migrations'>> {
  const tableNames = (
    await db.query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [schema])
  ).rows.map((row) => row.tablename);
  const tables: Record<string, number> = {};
  for (const table of tableNames) {
    const counted = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${quoteIdent(schema)}.${quoteIdent(table)}`);
    tables[table] = Number(counted.rows[0]?.n ?? 0);
  }
  const triggers = (
    await db.query<{ tgname: string }>(
      `SELECT t.tgname FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND NOT t.tgisinternal
        ORDER BY t.tgname`,
      [schema],
    )
  ).rows.map((row) => row.tgname);
  const migrations = tableNames.includes('schema_migrations')
    ? (
        await db.query<{ version: number; name: string; checksum: string }>(
          `SELECT version, name, checksum FROM ${quoteIdent(schema)}.schema_migrations ORDER BY version`,
        )
      ).rows
    : [];
  return { tables, triggers, migrations };
}

export interface BackupInput {
  /** A pool on the database to back up. */
  readonly pool: pg.Pool;
  readonly connectionString: string;
  readonly schema: string;
  readonly dir: string;
  readonly redact: (text: string) => string;
  readonly now?: Date;
}

/**
 * Dumps `schema` to `dir` and writes its manifest. The counts and the dump
 * come from one snapshot, so they describe exactly the same data even while
 * the worker keeps writing. The dump is written under a temporary name and
 * renamed when complete, so a crash never leaves a partial file that looks
 * finished.
 */
export async function createBackup(input: BackupInput): Promise<CreatedBackup> {
  const { pool, connectionString, schema, dir, redact } = input;
  assertBackupDir(dir);
  await mkdir(dir, { recursive: true });
  const env = pgToolEnv(connectionString);
  const database = databaseName(connectionString);

  const serverVersion = (await pool.query<{ server_version: string }>('SHOW server_version')).rows[0]?.server_version ?? '';
  const versionNum = (await pool.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0]?.server_version_num;
  const serverMajor = Math.floor(Number(versionNum) / 10_000);
  const dumpVersion = await assertToolVersion('pg_dump', serverMajor, env, redact);

  const createdAt = input.now ?? new Date();
  const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
  const base = `${database}-${schema}-${stamp}`;
  const file = path.join(dir, `${base}.dump`);
  const partial = `${file}.partial`;

  const client = await pool.connect();
  let contents: Pick<BackupManifest, 'tables' | 'triggers' | 'migrations'>;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // The transaction holds the snapshot open for pg_dump, idle, for as long
    // as the dump takes. It ends below, or with the connection.
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '0'");
    await client.query("SET LOCAL statement_timeout = '15min'");
    const snapshot = (await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id')).rows[0]?.id;
    if (!snapshot) throw new BackupError('Could not export a snapshot');
    contents = await describeSchema(client, schema);
    await runTool(
      'pg_dump',
      ['--format=custom', `--schema=${schema}`, `--snapshot=${snapshot}`, '--no-owner', '--no-privileges', `--file=${partial}`],
      env,
      redact,
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await rm(partial, { force: true });
    throw error;
  } finally {
    client.release();
  }

  const { bytes, sha256 } = await digest(partial);
  await rename(partial, file);
  const manifest: BackupManifest = {
    format: MANIFEST_FORMAT,
    created_at: createdAt.toISOString(),
    database,
    schema,
    server_version: serverVersion,
    server_major: serverMajor,
    pg_dump_version: dumpVersion,
    file: path.basename(file),
    bytes,
    sha256,
    ...contents,
  };
  const manifestFile = path.join(dir, `${base}.json`);
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  return { file, manifestFile, manifest };
}

function differences(expected: Pick<BackupManifest, 'tables' | 'triggers' | 'migrations'>, actual: typeof expected): string[] {
  const found: string[] = [];
  const names = new Set([...Object.keys(expected.tables), ...Object.keys(actual.tables)]);
  for (const name of [...names].sort()) {
    const want = expected.tables[name];
    const got = actual.tables[name];
    if (want !== got) found.push(`${name}: ${want ?? 'missing'} rows in the backup's manifest, ${got ?? 'missing'} restored`);
  }
  if (JSON.stringify(expected.triggers) !== JSON.stringify(actual.triggers)) {
    found.push(`triggers differ: ${expected.triggers.join(', ')} | restored: ${actual.triggers.join(', ')}`);
  }
  if (JSON.stringify(expected.migrations) !== JSON.stringify(actual.migrations)) found.push('applied migrations differ');
  return found;
}

/**
 * A pool on `<database>_restore_check`, after making sure that is really the
 * database it reached: nothing is ever dropped anywhere else.
 */
async function openRestoreCheckDatabase(connectionString: string, database: string): Promise<pg.Pool> {
  const target = restoreCheckDatabaseName(database);
  const pool = createPool(withDatabase(connectionString, target), { applicationName: 'morrow-restore-check', statementTimeoutMs: 900_000 });
  try {
    const current = (await pool.query<{ name: string }>('SELECT current_database() AS name')).rows[0]?.name;
    if (current !== target || !current.endsWith(RESTORE_CHECK_SUFFIX)) {
      throw new BackupError(`Connected to "${current}" instead of "${target}"; nothing was restored`);
    }
    return pool;
  } catch (error) {
    await pool.end();
    if ((error as { code?: string }).code === '3D000') {
      throw new BackupError(
        `The restore check database "${target}" does not exist. Create it once: scripts\\pg-local.ps1 init does, ` +
          `or a superuser runs CREATE DATABASE ${target} OWNER <the role in the database URL>.`,
      );
    }
    throw error;
  }
}

/** Fails now, before a dump that could take minutes, if the restore check could not run afterwards. */
export async function assertRestoreCheckPossible(connectionString: string): Promise<void> {
  const pool = await openRestoreCheckDatabase(connectionString, databaseName(connectionString));
  await pool.end();
}

/**
 * Restores a backup into `<database>_restore_check` and compares it with its
 * manifest: the file's checksum first, then every table's row count, the
 * triggers and the migrations. On success the restored schema is dropped
 * again and the manifest records the check (`restore_check`); on a mismatch
 * the schema is kept for inspection and the manifest is left without it.
 *
 * `connectionString` is the source database's: the check database is on the
 * same server, with the same role, which must own it.
 */
export async function checkRestore(input: {
  readonly connectionString: string;
  readonly manifestFile: string;
  readonly redact: (text: string) => string;
}): Promise<RestoreCheck> {
  const { connectionString, manifestFile, redact } = input;
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as BackupManifest;
  if (manifest.format !== MANIFEST_FORMAT) throw new BackupError(`${manifestFile} is not a Morrow backup manifest`);
  const file = path.join(path.dirname(manifestFile), manifest.file);
  const actualFile = await digest(file);
  if (actualFile.bytes !== manifest.bytes || actualFile.sha256 !== manifest.sha256) {
    throw new BackupError(`${file} does not match its manifest: the file is damaged or was replaced`);
  }

  const target = restoreCheckDatabaseName(manifest.database);
  const env = pgToolEnv(connectionString, target);
  const pool = await openRestoreCheckDatabase(connectionString, manifest.database);
  try {
    await assertToolVersion('pg_restore', manifest.server_major, env, redact);
    const listing = await runTool('pg_restore', ['--list', file], env, redact);
    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(manifest.schema)} CASCADE`);
    // Whether the archive creates the schema depends on how it was dumped and
    // on the PostgreSQL version; create it here only when the archive will not.
    if (!archiveCreatesSchema(listing, manifest.schema)) await pool.query(`CREATE SCHEMA ${quoteIdent(manifest.schema)}`);
    await runTool('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', `--dbname=${target}`, file], env, redact);

    const restored = await describeSchema(pool, manifest.schema);
    const found = differences(manifest, restored);
    if (found.length > 0) {
      throw new BackupError(
        `The restored copy does not match the backup (kept in "${target}", schema "${manifest.schema}", for inspection):\n  - ${found.join('\n  - ')}`,
      );
    }
    await pool.query(`DROP SCHEMA ${quoteIdent(manifest.schema)} CASCADE`);
    const passed: BackupManifest = { ...manifest, restore_check: { passed_at: new Date().toISOString(), database: target } };
    await writeFile(manifestFile, `${JSON.stringify(passed, null, 2)}\n`);
    const counts = Object.values(manifest.tables);
    return { database: target, tables: counts.length, rows: counts.reduce((sum, rows) => sum + rows, 0) };
  } finally {
    await pool.end();
  }
}
