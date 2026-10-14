import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { DEFAULT_WEB_ROOT } from '../api/server.js';
import { CREDENTIAL_VARIABLES, type AppConfig } from '../config/config.js';
import { assertBackupDir, assertRestoreCheckPossible, BackupError, parseToolMajor, toolVersion } from '../db/backup.js';
import { getMigrationStatus, MigrationError } from '../db/migrate.js';
import { CLOCK_SKEW_ATTENTION_MS, CLOCK_SKEW_DEGRADED_MS, CLOCK_SKEW_MIN_SAMPLES, measureClockSkew } from '../providers/clock-skew.js';
import { checkHosts, type HostCheck, type HostCheckOptions, providerHosts } from '../providers/reachability.js';
import { PROVIDERS } from '../providers/registry.js';

/*
 * `morrow doctor` (FT-05): checks that this machine can run Morrow, in one
 * place, before something fails halfway. It only reads: the toolchain, the
 * configuration, the database and its migrations, what backups need, which
 * credentials are set, and the clock. With --network it also opens a TLS
 * connection to each provider host (see reachability.ts), without sending a
 * request. Credentials are reported by the name of their setting; a value
 * is never printed.
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info' | 'skip';

export interface DoctorCheck {
  readonly status: CheckStatus;
  readonly name: string;
  readonly detail: string;
}

/** The Node.js versions this build supports; the same range as `engines` in package.json. */
export const SUPPORTED_NODE = { range: '>=24.19.0 <25', major: 24, minimum: [24, 19, 0] } as const;
/** The PostgreSQL major version the project targets and CI tests. */
export const TARGET_POSTGRES_MAJOR = 17;

export function checkNodeVersion(version: string): DoctorCheck {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  const [major = 0, minor = 0, patch = 0] = parts;
  const [minMajor, minMinor, minPatch] = SUPPORTED_NODE.minimum;
  const atLeast = major > minMajor || (major === minMajor && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
  const supported = major === SUPPORTED_NODE.major && atLeast;
  return {
    status: supported ? 'ok' : 'fail',
    name: 'Node.js',
    detail: supported
      ? `${version.replace(/^v/, '')}`
      : `${version.replace(/^v/, '')} is not supported; needs ${SUPPORTED_NODE.range} (scripts\\setup-toolchain.ps1 installs it)`,
  };
}

export function checkDashboardBuild(webRoot: string = DEFAULT_WEB_ROOT): DoctorCheck {
  return existsSync(path.join(webRoot, 'index.html'))
    ? { status: 'ok', name: 'Dashboard build', detail: 'built' }
    : { status: 'warn', name: 'Dashboard build', detail: 'not built: the API runs without a dashboard. Run npm run build' };
}

/** Which provider credentials are set, by the name of their settings. Never their values. */
export function checkCredentials(config: Pick<AppConfig, 'credentials'>): DoctorCheck[] {
  return Object.keys(PROVIDERS)
    .sort()
    .map((provider): DoctorCheck => {
      const name = `Credentials: ${provider}`;
      if (!Object.hasOwn(CREDENTIAL_VARIABLES, provider)) return { status: 'ok', name, detail: 'none needed' };
      const variables = CREDENTIAL_VARIABLES[provider as keyof typeof CREDENTIAL_VARIABLES];
      return config.credentials[provider as keyof typeof CREDENTIAL_VARIABLES] !== undefined
        ? { status: 'ok', name, detail: `set (${variables.join(', ')})` }
        : { status: 'warn', name, detail: `not set: ${variables.join(', ')}. Its capabilities report CREDENTIAL_MISSING` };
    });
}

export function checkBackupDir(config: Pick<AppConfig, 'backupDir'>): DoctorCheck {
  const name = 'Backup folder';
  if (config.backupDir === undefined) {
    return { status: 'warn', name, detail: 'MORROW_BACKUP_DIR is not set, so npm run backup cannot run' };
  }
  try {
    assertBackupDir(config.backupDir);
  } catch (error) {
    if (error instanceof BackupError) return { status: 'fail', name, detail: error.message };
    throw error;
  }
  // A file of that name would make the first backup fail at creating the folder.
  let entry: ReturnType<typeof statSync>;
  try {
    entry = statSync(config.backupDir, { throwIfNoEntry: false });
  } catch (error) {
    return { status: 'fail', name, detail: `cannot be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if (entry === undefined) return { status: 'ok', name, detail: 'set; created on the first backup' };
  if (!entry.isDirectory()) return { status: 'fail', name, detail: 'MORROW_BACKUP_DIR names a file, not a folder' };
  return { status: 'ok', name, detail: 'set and exists' };
}

export function checkClockSkew(clock: { readonly skew_ms: number | null; readonly samples: number }): DoctorCheck {
  const name = 'Clock skew';
  if (clock.skew_ms === null) {
    return {
      status: 'info',
      name,
      detail: `unknown: ${clock.samples} recent provider responses with a Date header, ${CLOCK_SKEW_MIN_SAMPLES} needed`,
    };
  }
  const seconds = `${clock.skew_ms >= 0 ? '+' : ''}${(clock.skew_ms / 1000).toFixed(1)} s`;
  const magnitude = Math.abs(clock.skew_ms);
  if (magnitude > CLOCK_SKEW_DEGRADED_MS) {
    return { status: 'fail', name, detail: `${seconds}: schedules are held and signed requests fail. Sync this machine's clock` };
  }
  if (magnitude > CLOCK_SKEW_ATTENTION_MS) return { status: 'warn', name, detail: `${seconds}: sync this machine's clock` };
  return { status: 'ok', name, detail: seconds };
}

export function checkToolVersion(tool: string, output: string | null, serverMajor: number | null): DoctorCheck {
  if (output === null) {
    return { status: 'warn', name: tool, detail: 'not on PATH, so npm run backup cannot run (scripts\\dev-env.ps1 adds it)' };
  }
  const major = parseToolMajor(output);
  if (serverMajor !== null && (major === null || major < serverMajor)) {
    return { status: 'warn', name: tool, detail: `${output}: older than the PostgreSQL ${serverMajor} server, so backups would fail` };
  }
  return { status: 'ok', name: tool, detail: output };
}

const HOST_ADVICE: Record<HostCheck['result'], string> = {
  OK: '',
  DNS_FAILED: 'the name does not resolve',
  CONNECT_FAILED: 'no connection',
  TIMEOUT: 'no answer within 5 s',
  TLS_UNTRUSTED: 'the certificate does not verify; on a managed network this is usually TLS interception',
  TLS_FAILED: 'the TLS handshake failed',
};

export function checkHostResults(results: readonly HostCheck[]): DoctorCheck[] {
  return results.map((check) =>
    check.result === 'OK'
      ? { status: 'ok', name: `Host ${check.host}`, detail: `TLS handshake in ${check.durationMs} ms` }
      : {
          status: 'fail',
          name: `Host ${check.host}`,
          detail: `${check.result}${check.code ? ` (${check.code})` : ''}: ${HOST_ADVICE[check.result]}`,
        },
  );
}

/** The database checks: reachable, its version, migrations, and then what needs the schema (clock skew). */
async function checkDatabase(pool: pg.Pool, redact: (text: string) => string, migrationsDir?: string): Promise<{ checks: DoctorCheck[]; serverMajor: number | null }> {
  const checks: DoctorCheck[] = [];
  let serverMajor: number | null = null;
  try {
    const version = await pool.query<{ num: number; version: string }>(
      "SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS version",
    );
    const row = version.rows[0];
    serverMajor = row ? Math.floor(row.num / 10_000) : null;
    checks.push(
      serverMajor === TARGET_POSTGRES_MAJOR
        ? { status: 'ok', name: 'Database', detail: `PostgreSQL ${row?.version}` }
        : {
            status: 'warn',
            name: 'Database',
            detail: `PostgreSQL ${row?.version}; the project targets ${TARGET_POSTGRES_MAJOR}, the version CI tests`,
          },
    );
  } catch (error) {
    checks.push({
      status: 'fail',
      name: 'Database',
      detail: `unreachable (${describe(error, redact)}). Is it running? scripts\\pg-local.ps1 start`,
    });
    checks.push({ status: 'skip', name: 'Migrations', detail: 'needs the database' });
    checks.push({ status: 'skip', name: 'Clock skew', detail: 'needs the database' });
    return { checks, serverMajor };
  }

  // Every failure from here on is a check, not an exception: a connection
  // that drops halfway must not cost the report everything after it.
  let current = false;
  try {
    const status = await getMigrationStatus(pool, migrationsDir);
    current = status.pending === 0;
    checks.push(
      current
        ? { status: 'ok', name: 'Migrations', detail: `${status.applied} applied, none pending` }
        : { status: 'fail', name: 'Migrations', detail: `${status.applied} applied, ${status.pending} pending: run npm run migrate` },
    );
  } catch (error) {
    const detail = error instanceof MigrationError ? redact(error.message) : `could not be read (${describe(error, redact)})`;
    checks.push({ status: 'fail', name: 'Migrations', detail });
  }
  if (!current) {
    checks.push({ status: 'skip', name: 'Clock skew', detail: 'needs the migrations' });
  } else {
    try {
      checks.push(checkClockSkew(await measureClockSkew(pool)));
    } catch (error) {
      checks.push({ status: 'fail', name: 'Clock skew', detail: `could not be read (${describe(error, redact)})` });
    }
  }
  return { checks, serverMajor };
}

const describe = (error: unknown, redact: (text: string) => string): string =>
  error instanceof Error ? redact(error.message) : 'unknown error';

async function checkRestoreDatabase(databaseUrl: string, redact: (text: string) => string): Promise<DoctorCheck> {
  try {
    await assertRestoreCheckPossible(databaseUrl);
    return { status: 'ok', name: 'Restore check database', detail: 'exists' };
  } catch (error) {
    const reason = error instanceof Error ? redact(error.message) : String(error);
    return { status: 'warn', name: 'Restore check database', detail: `${reason}. npm run backup needs it` };
  }
}

export interface DoctorInput {
  readonly config: AppConfig;
  readonly pool: pg.Pool;
  readonly redact: (text: string) => string;
  /** Also check the provider hosts; the caller refuses it in OFF mode. */
  readonly network: boolean;
  readonly nodeVersion?: string;
  readonly webRoot?: string;
  readonly migrationsDir?: string;
  readonly hosts?: readonly string[];
  readonly hostOptions?: HostCheckOptions;
  /** Replaces running `<tool> --version`; for tests. */
  readonly readToolVersion?: (tool: string) => Promise<string | null>;
}

export async function runDoctor(input: DoctorInput): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [
    checkNodeVersion(input.nodeVersion ?? process.version),
    checkDashboardBuild(input.webRoot),
    { status: 'info', name: 'Mode', detail: `${input.config.mode}, API on 127.0.0.1:${input.config.apiPort}` },
  ];
  const database = await checkDatabase(input.pool, input.redact, input.migrationsDir);
  checks.push(...database.checks);
  checks.push(await checkRestoreDatabase(input.config.databaseUrl, input.redact));
  for (const tool of ['pg_dump', 'pg_restore']) {
    try {
      checks.push(checkToolVersion(tool, await (input.readToolVersion ?? toolVersion)(tool), database.serverMajor));
    } catch (error) {
      checks.push({ status: 'warn', name: tool, detail: `found, but could not be run (${describe(error, input.redact)})` });
    }
  }
  checks.push(checkBackupDir(input.config));
  checks.push(...checkCredentials(input.config));
  if (input.network) {
    checks.push(...checkHostResults(await checkHosts(input.hosts ?? providerHosts(), input.hostOptions)));
  } else {
    checks.push({ status: 'skip', name: 'Provider hosts', detail: 'not checked; add --network (opens a TLS connection, sends no request)' });
  }
  return checks;
}

const LABELS: Record<CheckStatus, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', info: 'INFO', skip: 'SKIP' };

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  const lines = checks.map((check) => `  ${LABELS[check.status]}  ${check.name.padEnd(width)}  ${check.detail}`);
  const count = (status: CheckStatus): number => checks.filter((check) => check.status === status).length;
  const failures = count('fail');
  const warnings = count('warn');
  lines.push('', `${failures} ${failures === 1 ? 'failure' : 'failures'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}.`);
  return lines.join('\n');
}
