import type pg from 'pg';
import { API_HOST, buildApiServer } from '../api/server.js';
import type { AppConfig } from '../config/config.js';
import { getMigrationStatus } from '../db/migrate.js';
import { type Schedule, Scheduler, validateSchedules } from '../jobs/scheduler.js';
import { JobWorker, type JobHandler } from '../jobs/worker.js';
import type { Logger } from '../logging/logger.js';
import { ingestRawObservation, PARSE_JOB_KIND } from '../parsers/ingest.js';
import { ProviderClient } from '../providers/client.js';
import { CLOCK_SKEW_DEGRADED_MS, measureClockSkew } from '../providers/clock-skew.js';
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
      redact: deps.redact,
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
 * exists, so it registers nothing that would contact a provider. Parsing
 * reads stored evidence only, so it runs in every mode.
 */
export function defaultHandlers(deps: ProcessDeps, getSessionId: () => string): Map<string, JobHandler> {
  const handlers = new Map<string, JobHandler>();
  handlers.set(PARSE_JOB_KIND, async (job) => {
    const id = job.payload['raw_observation_id'];
    if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) throw new Error('raw.parse job has no valid raw_observation_id');
    const summary = await ingestRawObservation(deps.pool, id);
    deps.logger.info({ ...summary }, 'raw observation parsed');
  });
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

/**
 * The fixed schedules the worker runs in RESEARCH and PAPER mode. None yet:
 * the only job kinds so far are parse (triggered by evidence) and probe (run
 * by hand). Each blueprint cadence (docs/plans/active-plan.md, 固定排程:
 * Jupiter recent every 60 s, OKX hot-token every 5 minutes, ...) is added
 * here together with the handler it needs.
 */
export function defaultSchedules(_deps: ProcessDeps): Schedule[] {
  return [];
}

/**
 * Job kinds that only read and write the local database. They run in the
 * local lane, so a slow provider never delays them. Every other kind runs in
 * the network lane, one job at a time behind the shared rate limiter. The
 * list is explicit so that a new kind that might contact a provider is never
 * run beside provider jobs by accident.
 */
export const LOCAL_JOB_KINDS: ReadonlySet<string> = new Set([PARSE_JOB_KIND]);

export type WorkerLane = 'local' | 'network';

/** Splits handlers by lane, using `LOCAL_JOB_KINDS`. */
export function laneHandlers(handlers: ReadonlyMap<string, JobHandler>): Record<WorkerLane, Map<string, JobHandler>> {
  const lanes: Record<WorkerLane, Map<string, JobHandler>> = { local: new Map(), network: new Map() };
  for (const [kind, handler] of handlers) lanes[LOCAL_JOB_KINDS.has(kind) ? 'local' : 'network'].set(kind, handler);
  return lanes;
}

/**
 * Starts the background worker: the job loops and, through them, all
 * provider access. Each lane is its own loop that runs one job at a time, so
 * provider requests stay serial while local work proceeds beside them.
 */
export async function startWorkerProcess(
  deps: ProcessDeps & {
    /** Replaces the default handlers. Tests use this to stay off the network. */
    readonly handlers?: ReadonlyMap<string, JobHandler>;
    /** Replaces the default schedules. */
    readonly schedules?: readonly Schedule[];
  },
): Promise<RunningProcess> {
  await assertSchemaCurrent(deps.pool, deps.migrationsDir);
  // Schedules run only where providers may be contacted. Slots that pass in
  // OFF mode are recorded as gaps when a later RESEARCH or PAPER run starts.
  const schedules = deps.config.mode === 'OFF' ? [] : (deps.schedules ?? defaultSchedules(deps));
  validateSchedules(schedules);
  // Handlers read the session id only when a job runs, after it is known.
  let sessionId = '';
  const handlers = deps.handlers ?? defaultHandlers(deps, () => sessionId);
  // A slot job nobody handles would stay queued, and every later slot would be skipped behind it.
  const unhandled = schedules.filter((schedule) => !handlers.has(schedule.kind));
  if (unhandled.length > 0) {
    throw new Error(`No handler for the job kind of schedule(s): ${unhandled.map((schedule) => schedule.name).join(', ')}`);
  }

  const started = await startSession(deps.pool, {
    component: 'worker',
    mode: deps.config.mode,
    appVersion: APP_VERSION,
  });
  sessionId = started.sessionId;
  const { gap } = started;

  const lanes = laneHandlers(handlers);
  const workers = (Object.entries(lanes) as [WorkerLane, Map<string, JobHandler>][])
    .filter(([, handlers]) => handlers.size > 0)
    .map(
      ([lane, handlers]) =>
        new JobWorker({
          pool: deps.pool,
          logger: deps.logger.child({ lane }),
          workerId: `worker:${sessionId}:${lane}`,
          handlers,
          redact: deps.redact,
        }),
    );
  for (const worker of workers) worker.start();
  const scheduler =
    schedules.length > 0
      ? new Scheduler({
          pool: deps.pool,
          logger: deps.logger,
          schedules,
          sessionId,
          clockSkewMs: async () => (await measureClockSkew(deps.pool)).skew_ms,
          maxClockSkewMs: CLOCK_SKEW_DEGRADED_MS,
        })
      : null;
  scheduler?.start();
  deps.logger.info(
    {
      mode: deps.config.mode,
      sessionId,
      lanes: { local: [...lanes.local.keys()], network: [...lanes.network.keys()] },
      schedules: schedules.map((schedule) => schedule.name),
      previousGap: gap?.kind ?? null,
    },
    'worker started',
  );
  if (gap) {
    deps.logger.warn(
      { kind: gap.kind, gapStart: gap.start.toISOString(), gapEnd: gap.end.toISOString() },
      'nothing was observed during this interval; it is recorded as a coverage gap',
    );
  }
  return supervise(deps, 'worker', sessionId, async () => {
    // No new slots once stopping; jobs already enqueued stay for the next run.
    await scheduler?.stop();
    await Promise.all(workers.map((worker) => worker.stop()));
  });
}
