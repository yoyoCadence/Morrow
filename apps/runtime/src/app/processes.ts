import type pg from 'pg';
import { API_HOST, buildApiServer } from '../api/server.js';
import type { AppConfig } from '../config/config.js';
import { getMigrationStatus } from '../db/migrate.js';
import { JobWorker, type JobHandler } from '../jobs/worker.js';
import type { Logger } from '../logging/logger.js';
import { ProviderClient } from '../providers/client.js';
import { PROBE_JOB_KIND, runProbes } from '../providers/probes.js';
import { keepSessionAlive, startSession, stopSession, type Component } from '../session/run-session.js';
import { APP_VERSION } from '../version.js';

export class SchemaNotCurrentError extends Error {
  constructor(pending: number) {
    super(`The database has ${pending} pending migration(s). Run "npm run migrate" before starting.`);
    this.name = 'SchemaNotCurrentError';
  }
}

export type StopReason = 'signal' | 'stop_requested' | 'session_lost' | 'test';

export interface RunningProcess {
  readonly sessionId: string;
  /** Shuts down cleanly. Safe to call more than once. */
  stop(reason: StopReason): Promise<void>;
  /** Resolves once shutdown has finished, whoever started it. */
  readonly stopped: Promise<void>;
}

export interface ProcessDeps {
  readonly config: AppConfig;
  /** The caller owns the pool and closes it after `stopped` resolves. */
  readonly pool: pg.Pool;
  readonly logger: Logger;
  readonly redact: (text: string) => string;
  readonly heartbeatIntervalMs?: number;
  readonly migrationsDir?: string;
}

async function assertSchemaCurrent(pool: pg.Pool, migrationsDir?: string): Promise<void> {
  const status = await getMigrationStatus(pool, migrationsDir);
  if (status.pending > 0) throw new SchemaNotCurrentError(status.pending);
}

/** Wires session lifetime to a component: heartbeats while it runs, a clean STOPPED record when it ends. */
function supervise(
  deps: ProcessDeps,
  component: Component,
  sessionId: string,
  shutdown: () => Promise<void>,
): RunningProcess {
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  let stopping: Promise<void> | null = null;
  const stop = (reason: StopReason): Promise<void> => {
    stopping ??= (async () => {
      deps.logger.info({ reason }, `${component} stopping`);
      stopHeartbeat();
      await shutdown();
      // A lost session already belongs to another process; leave its record alone.
      if (reason !== 'session_lost') await stopSession(deps.pool, sessionId, component);
      deps.logger.info(`${component} stopped`);
    })().finally(resolveStopped);
    return stopping;
  };

  const stopHeartbeat = keepSessionAlive({
    pool: deps.pool,
    sessionId,
    component,
    ...(deps.heartbeatIntervalMs !== undefined ? { intervalMs: deps.heartbeatIntervalMs } : {}),
    onShutdownRequested: (reason) => {
      void stop(reason).catch((error: unknown) => deps.logger.error({ err: error }, 'shutdown failed'));
    },
    onStall: (gap) =>
      deps.logger.warn(
        { gapStart: gap.start.toISOString(), gapEnd: gap.end.toISOString() },
        'heartbeat stall recorded as a coverage gap',
      ),
    onError: (error) => deps.logger.error({ err: error }, 'heartbeat failed'),
  });

  return { sessionId, stop, stopped };
}

/** Starts the HTTP API on loopback. */
export async function startApiProcess(deps: ProcessDeps & { readonly webRoot?: string }): Promise<RunningProcess> {
  await assertSchemaCurrent(deps.pool, deps.migrationsDir);
  const { sessionId, gap } = await startSession(deps.pool, {
    component: 'api',
    mode: deps.config.mode,
    appVersion: APP_VERSION,
  });

  try {
    const app = await buildApiServer({
      pool: deps.pool,
      logger: deps.logger,
      mode: deps.config.mode,
      version: APP_VERSION,
      port: deps.config.apiPort,
      ...(deps.webRoot !== undefined ? { webRoot: deps.webRoot } : {}),
      ...(deps.migrationsDir !== undefined ? { migrationsDir: deps.migrationsDir } : {}),
    });
    await app.listen({ host: API_HOST, port: deps.config.apiPort });
    deps.logger.info({ mode: deps.config.mode, sessionId, previousGap: gap?.kind ?? null }, 'api started');
    return supervise(deps, 'api', sessionId, () => app.close());
  } catch (error) {
    await stopSession(deps.pool, sessionId, 'api');
    throw error;
  }
}

/**
 * Job handlers available in a mode. OFF only inspects data that already
 * exists, so it registers nothing that would contact a provider.
 */
export function defaultHandlers(deps: ProcessDeps, getSessionId: () => string): Map<string, JobHandler> {
  const handlers = new Map<string, JobHandler>();
  if (deps.config.mode === 'OFF') return handlers;

  const client = new ProviderClient({
    pool: deps.pool,
    logger: deps.logger,
    credentials: deps.config.credentials,
    redact: deps.redact,
    getRunSessionId: getSessionId,
  });
  handlers.set(PROBE_JOB_KIND, async (job) => {
    await runProbes({ pool: deps.pool, client, jobId: job.id, runSessionId: getSessionId() });
  });
  return handlers;
}

/** Starts the background worker: the job loop and, through it, all provider access. */
export async function startWorkerProcess(
  deps: ProcessDeps & {
    /** Replaces the default handlers. Tests use this to stay off the network. */
    readonly handlers?: ReadonlyMap<string, JobHandler>;
  },
): Promise<RunningProcess> {
  await assertSchemaCurrent(deps.pool, deps.migrationsDir);
  const { sessionId, gap } = await startSession(deps.pool, {
    component: 'worker',
    mode: deps.config.mode,
    appVersion: APP_VERSION,
  });

  const handlers = deps.handlers ?? defaultHandlers(deps, () => sessionId);
  const worker = new JobWorker({
    pool: deps.pool,
    logger: deps.logger,
    workerId: `worker:${sessionId}`,
    handlers,
    redact: deps.redact,
  });
  worker.start();
  deps.logger.info(
    { mode: deps.config.mode, sessionId, jobKinds: [...handlers.keys()], previousGap: gap?.kind ?? null },
    'worker started',
  );
  if (gap) {
    deps.logger.warn(
      { kind: gap.kind, gapStart: gap.start.toISOString(), gapEnd: gap.end.toISOString() },
      'nothing was observed during this interval; it is recorded as a coverage gap',
    );
  }
  return supervise(deps, 'worker', sessionId, () => worker.stop());
}
