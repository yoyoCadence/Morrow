import { ModeNotEnabledError } from '@morrow/core';
import type pg from 'pg';
import { buildHealthReport } from './api/health.js';
import { formatDoctor, runDoctor } from './app/doctor.js';
import { SchemaNotCurrentError, startApiProcess, startWorkerProcess, type RunningProcess } from './app/processes.js';
import { ConfigError, loadConfig, type AppConfig } from './config/config.js';
import { migrate, MigrationError } from './db/migrate.js';
import { createPool, isConnectionTimeout, type PoolOptions } from './db/pool.js';
import { assertRestoreCheckPossible, BackupError, checkRestore, createBackup } from './db/backup.js';
import { formatBytes, formatStorageReport, measureStorage } from './db/storage.js';
import { enqueueJob, getJobState } from './jobs/job-queue.js';
import { sleep } from './jobs/worker.js';
import { createLogger } from './logging/logger.js';
import { createRedactor } from './logging/redact.js';
import { planReparse, reparse } from './parsers/reparse.js';
import { PROBE_JOB_KIND, readProbeRecords } from './providers/probes.js';
import { requestStop, SessionConflictError, waitForStop, type Component } from './session/run-session.js';
import { APP_VERSION } from './version.js';

const USAGE = `Morrow ${APP_VERSION} (research and Paper only)

Usage: morrow <command>

  migrate            Apply pending database migrations.
  api                Run the local API and dashboard on 127.0.0.1.
  worker             Run the background worker.
  stop [api|worker]  Ask running processes to shut down cleanly (default: both).
  probe              Measure what the configured provider credentials can use.
  status             Print the health report as JSON.
  storage            Print the size and daily growth of each table.
  backup             Dump the database to MORROW_BACKUP_DIR and check that it restores.
  reparse [--dry-run]
                     Parse stored responses with the current parser versions where
                     that has not happened yet. Earlier versions' events are kept.
  doctor [--network] Check the toolchain, database, migrations, backups, which
                     credentials are set and the clock. --network also opens a TLS
                     connection to each provider host, without sending a request.
`;

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function withPool<T>(
  config: AppConfig,
  name: string,
  work: (pool: pg.Pool) => Promise<T>,
  options: Pick<PoolOptions, 'statementTimeoutMs'> = {},
): Promise<T> {
  const pool = createPool(config.databaseUrl, { applicationName: `morrow-${name}`, ...options });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

async function runDaemon(
  config: AppConfig,
  component: Component,
  start: typeof startApiProcess | typeof startWorkerProcess,
): Promise<number> {
  const redact = createRedactor(config.secretValues);
  const logger = createLogger({ level: config.logLevel, component, redact });
  return withPool(config, component, async (pool) => {
    const running: RunningProcess = await start({ config, pool, logger, redact });
    const onSignal = (): void => {
      void running.stop('signal').catch((error: unknown) => logger.error({ err: error }, 'shutdown failed'));
    };
    // Ctrl+C, and Ctrl+Break on Windows. Windows has no SIGTERM to speak of;
    // "morrow stop" is the way to stop a process that has no console.
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    process.once('SIGBREAK', onSignal);
    await running.stopped;
    return 0;
  });
}

async function commandMigrate(config: AppConfig): Promise<number> {
  // A migration may legitimately run long or wait for a lock, so it has no statement timeout.
  return withPool(config, 'migrate', async (pool) => {
    const result = await migrate(pool);
    if (result.applied.length === 0) {
      print(`Database is up to date (${result.alreadyApplied} migration(s) applied).`);
    } else {
      for (const migration of result.applied) {
        print(`Applied ${String(migration.version).padStart(4, '0')}_${migration.name}`);
      }
    }
    return 0;
  }, { statementTimeoutMs: 0 });
}

async function commandStop(config: AppConfig, target: string | undefined): Promise<number> {
  const components: Component[] = target === 'api' || target === 'worker' ? [target] : ['api', 'worker'];
  if (target !== undefined && target !== 'all' && components.length !== 1) {
    print(`Unknown component "${target}". Use api, worker or all.`);
    return 2;
  }
  return withPool(config, 'stop', async (pool) => {
    const asked = await requestStop(pool, components);
    if (asked.length > 0) print(`Stop requested for: ${asked.join(', ')}. Waiting for clean shutdown...`);
    // Includes sessions whose stop was already pending, and ones that went silent.
    const outcomes = await waitForStop(pool, components, { timeoutMs: 30_000 });
    if (outcomes.length === 0) {
      print('Nothing to stop: no matching process is running.');
      return 0;
    }
    for (const outcome of outcomes) {
      if (outcome.result === 'stopped') print(`${outcome.component}: stopped.`);
      else if (outcome.result === 'not_running') {
        print(
          `${outcome.component}: not running. No heartbeat for ${Math.round(outcome.silentForMs / 1000)}s, so it crashed ` +
            'or was killed. Its next start records the silence as an UNCLEAN_SHUTDOWN gap.',
        );
      } else print(`${outcome.component}: still running after 30s. The process may be busy or frozen; check its log.`);
    }
    return outcomes.some((outcome) => outcome.result === 'still_running') ? 1 : 0;
  });
}

async function commandProbe(config: AppConfig): Promise<number> {
  if (config.mode === 'OFF') {
    print('MORROW_MODE is OFF, which does not contact providers. Set RESEARCH or PAPER to probe.');
    return 2;
  }
  return withPool(config, 'probe', async (pool) => {
    // Probes run in the worker, the one process allowed to call providers, so
    // they share its rate limiting. Reuse a probe that is already waiting.
    const active = await pool.query<{ id: string }>(
      "SELECT id FROM jobs WHERE kind = $1 AND status IN ('queued', 'leased') ORDER BY id LIMIT 1",
      [PROBE_JOB_KIND],
    );
    const jobId = active.rows[0]?.id ?? (await enqueueJob(pool, { kind: PROBE_JOB_KIND, maxAttempts: 1 })).jobId;
    print(`Probe job ${jobId} queued. Waiting for the worker...`);

    const deadline = Date.now() + 180_000;
    let hinted = false;
    while (Date.now() < deadline) {
      const state = await getJobState(pool, jobId);
      if (state?.status === 'succeeded' || state?.status === 'dead') {
        const records = await readProbeRecords(pool, jobId);
        print('');
        for (const record of records) {
          const status = record.httpStatus === null ? '' : ` (HTTP ${record.httpStatus})`;
          print(`${`${record.provider}/${record.capability}`.padEnd(34)} ${record.outcome}${status}`);
        }
        print('');
        if (state.status === 'dead') {
          print(`Probe job failed: ${state.lastError ?? 'unknown error'}`);
          return 1;
        }
        print('Details and raw responses are stored in provider_probes and raw_observations.');
        return 0;
      }
      if (!hinted && state?.status === 'queued' && Date.now() > deadline - 170_000) {
        print('Still queued. Is the worker running? Start it with: npm run worker');
        hinted = true;
      }
      await sleep(500);
    }
    print('Timed out waiting for the probe job. It stays queued and will run when the worker starts.');
    return 1;
  });
}

async function commandStatus(config: AppConfig): Promise<number> {
  return withPool(config, 'status', async (pool) => {
    const report = await buildHealthReport({ pool, mode: config.mode, version: APP_VERSION });
    print(JSON.stringify(report, null, 2));
    return report.status === 'ok' ? 0 : 1;
  });
}

async function commandStorage(config: AppConfig): Promise<number> {
  // Counting rows scans every table, which can outlast the default 30 s on a large database.
  return withPool(
    config,
    'storage',
    async (pool) => {
      print(formatStorageReport(await measureStorage(pool)));
      return 0;
    },
    { statementTimeoutMs: 300_000 },
  );
}

async function commandBackup(config: AppConfig): Promise<number> {
  if (config.backupDir === undefined) {
    print('MORROW_BACKUP_DIR is not set. Set it in .env to an absolute folder outside the repository, ideally on another disk.');
    return 2;
  }
  const backupDir = config.backupDir;
  const redact = createRedactor(config.secretValues);
  // Counting rows scans every table, like `storage`.
  return withPool(
    config,
    'backup',
    async (pool) => {
      await assertRestoreCheckPossible(config.databaseUrl);
      const backup = await createBackup({ pool, connectionString: config.databaseUrl, schema: 'public', dir: backupDir, redact });
      const rows = Object.values(backup.manifest.tables).reduce((sum, count) => sum + count, 0);
      print(`Backup written: ${backup.file} (${formatBytes(backup.manifest.bytes)}, ${rows} rows)`);
      const check = await checkRestore({ connectionString: config.databaseUrl, manifestFile: backup.manifestFile, redact });
      print(`Restore check passed: ${check.tables} tables and ${check.rows} rows restored into "${check.database}" match the backup.`);
      return 0;
    },
    { statementTimeoutMs: 300_000 },
  );
}

async function commandReparse(config: AppConfig, argument: string | undefined): Promise<number> {
  if (argument !== undefined && argument !== '--dry-run') {
    print(`Unknown option "${argument}". Usage: morrow reparse [--dry-run]`);
    return 2;
  }
  // Counting what is pending reads every stored response, like `storage`.
  return withPool(
    config,
    'reparse',
    async (pool) => {
      const plan = await planReparse(pool);
      for (const entry of plan) {
        print(
          `${entry.provider}/${entry.capability} with ${entry.parserVersion}: ${entry.responses} successful responses, ` +
            `${entry.parsed} already parsed by this version, ${entry.pending} to parse.`,
        );
      }
      if (argument === '--dry-run') {
        print('Dry run: nothing was written.');
        return 0;
      }
      // Run even when nothing is pending, so that every run is in the audit log.
      const results = await reparse(pool, {
        onProgress: (totals) => {
          if (totals.parsed > 0 && totals.parsed % 100 === 0) print(`  ${totals.parserVersion}: ${totals.parsed} parsed`);
        },
      });
      for (const result of results) {
        print(
          `Parsed ${result.parsed} responses with ${result.parserVersion}: ${result.eventsInserted} events added, ` +
            `${result.quarantined} fields quarantined.`,
        );
        if (result.alreadyParsed > 0) print(`  ${result.alreadyParsed} were parsed meanwhile by another process.`);
      }
      print('Events from earlier parser versions are unchanged. The run is recorded in audit_log.');
      return 0;
    },
    { statementTimeoutMs: 300_000 },
  );
}

async function commandDoctor(config: AppConfig, argument: string | undefined): Promise<number> {
  if (argument !== undefined && argument !== '--network') {
    print(`Unknown option "${argument}". Usage: morrow doctor [--network]`);
    return 2;
  }
  const network = argument === '--network';
  if (network && config.mode === 'OFF') {
    print('MORROW_MODE is OFF, which does not contact providers. Set RESEARCH or PAPER to check the provider hosts.');
    return 2;
  }
  const redact = createRedactor(config.secretValues);
  return withPool(config, 'doctor', async (pool) => {
    const checks = await runDoctor({ config, pool, redact, network });
    print(`Morrow ${APP_VERSION} doctor\n`);
    print(formatDoctor(checks));
    return checks.some((check) => check.status === 'fail') ? 1 : 0;
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, argument] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    print(USAGE);
    return command === undefined ? 2 : 0;
  }
  const commands: Record<string, (config: AppConfig) => Promise<number>> = {
    migrate: commandMigrate,
    api: (config) => runDaemon(config, 'api', startApiProcess),
    worker: (config) => runDaemon(config, 'worker', startWorkerProcess),
    stop: (config) => commandStop(config, argument),
    probe: commandProbe,
    status: commandStatus,
    storage: commandStorage,
    backup: commandBackup,
    reparse: (config) => commandReparse(config, argument),
    doctor: (config) => commandDoctor(config, argument),
  };
  const run = commands[command];
  if (!run) {
    print(`Unknown command "${command}".\n\n${USAGE}`);
    return 2;
  }
  // Configuration is validated before anything touches the database or the
  // network. A request for a live mode ends here.
  return run(loadConfig(process.env));
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const expected =
      error instanceof ConfigError ||
      error instanceof ModeNotEnabledError ||
      error instanceof SchemaNotCurrentError ||
      error instanceof SessionConflictError ||
      error instanceof MigrationError ||
      error instanceof BackupError;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (expected) {
      process.stderr.write(`${error.message}\n`);
      if (error instanceof MigrationError && error.cause instanceof Error) {
        process.stderr.write(`Cause: ${error.cause.message}\n`);
      }
    } else if (
      code === 'ECONNREFUSED' ||
      code === 'ENOTFOUND' ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNRESET' ||
      isConnectionTimeout(error)
    ) {
      process.stderr.write(
        `Cannot reach the database (${code ?? 'connection timed out'}). Is PostgreSQL running? For the local cluster: .\\scripts\\pg-local.ps1 start\n`,
      );
    } else if (code === 'EADDRINUSE') {
      process.stderr.write('The API port is already in use. Stop the other process or set MORROW_API_PORT.\n');
    } else {
      process.stderr.write(`Unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    }
    process.exitCode = expected ? 2 : 1;
  },
);
