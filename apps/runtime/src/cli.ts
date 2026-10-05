import { ModeNotEnabledError } from '@morrow/core';
import type pg from 'pg';
import { buildHealthReport } from './api/health.js';
import { SchemaNotCurrentError, startApiProcess, startWorkerProcess, type RunningProcess } from './app/processes.js';
import { ConfigError, loadConfig, type AppConfig } from './config/config.js';
import { migrate, MigrationError } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { enqueueJob, getJobState } from './jobs/job-queue.js';
import { sleep } from './jobs/worker.js';
import { createLogger } from './logging/logger.js';
import { createRedactor } from './logging/redact.js';
import { PROBE_JOB_KIND, readProbeRecords } from './providers/probes.js';
import { requestStop, SessionConflictError, type Component } from './session/run-session.js';
import { APP_VERSION } from './version.js';

const USAGE = `Morrow ${APP_VERSION} (research and Paper only)

Usage: morrow <command>

  migrate            Apply pending database migrations.
  api                Run the local API and dashboard on 127.0.0.1.
  worker             Run the background worker.
  stop [api|worker]  Ask running processes to shut down cleanly (default: both).
  probe              Measure what the configured provider credentials can use.
  status             Print the health report as JSON.
`;

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

async function withPool<T>(config: AppConfig, name: string, work: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = createPool(config.databaseUrl, { applicationName: `morrow-${name}` });
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
  });
}

async function commandStop(config: AppConfig, target: string | undefined): Promise<number> {
  const components: Component[] = target === 'api' || target === 'worker' ? [target] : ['api', 'worker'];
  if (target !== undefined && target !== 'all' && components.length !== 1) {
    print(`Unknown component "${target}". Use api, worker or all.`);
    return 2;
  }
  return withPool(config, 'stop', async (pool) => {
    const asked = await requestStop(pool, components);
    if (asked.length === 0) {
      print('Nothing to stop: no matching process is running, or a stop is already pending.');
      return 0;
    }
    print(`Stop requested for: ${asked.join(', ')}. Waiting for clean shutdown...`);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const remaining = await pool.query<{ component: string }>(
        "SELECT component FROM run_sessions WHERE status = 'RUNNING' AND component = ANY($1::text[])",
        [asked],
      );
      if (remaining.rows.length === 0) {
        print('Stopped.');
        return 0;
      }
      await sleep(500);
    }
    print('Still running after 30s. The process may be busy or frozen; check its log.');
    return 1;
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
      error instanceof MigrationError;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (expected) {
      process.stderr.write(`${error.message}\n`);
      if (error instanceof MigrationError && error.cause instanceof Error) {
        process.stderr.write(`Cause: ${error.cause.message}\n`);
      }
    } else if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'ECONNRESET') {
      process.stderr.write(
        `Cannot reach the database (${code}). Is PostgreSQL running? For the local cluster: .\\scripts\\pg-local.ps1 start\n`,
      );
    } else if (code === 'EADDRINUSE') {
      process.stderr.write('The API port is already in use. Stop the other process or set MORROW_API_PORT.\n');
    } else {
      process.stderr.write(`Unexpected failure: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    }
    process.exitCode = expected ? 2 : 1;
  },
);
