import pg from 'pg';

/** Anything a query can be run on: the pool, or one client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

export interface PoolOptions {
  readonly applicationName: string;
  /** Schema to resolve unqualified names in. Used by tests to isolate each file. */
  readonly schema?: string;
  readonly max?: number;
  /**
   * Longest a statement may run on the server, including time spent waiting
   * for a lock. 0 turns it off, which only migrations should do. Default 30 s.
   */
  readonly statementTimeoutMs?: number;
  /**
   * Longest this process waits for any answer to a query. It covers what the
   * server cannot: a connection that died without closing, for example after
   * the machine slept. Defaults to the statement timeout plus 10 s, and is off
   * when the statement timeout is.
   */
  readonly queryTimeoutMs?: number;
  /** Longest a new connection may take. Default 10 s. */
  readonly connectionTimeoutMs?: number;
}

export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
/** A transaction left open this long is ended by the server, releasing its locks. */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/** The error node-postgres raises when `queryTimeoutMs` runs out. */
const QUERY_READ_TIMEOUT = 'Query read timeout';

export function isQueryReadTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === QUERY_READ_TIMEOUT;
}

/** True when a new connection was given up on after `connectionTimeoutMs`. Such errors carry no code. */
export function isConnectionTimeout(error: unknown): boolean {
  return error instanceof Error && /connection timeout|timeout expired/i.test(error.message);
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function createPool(connectionString: string, options: PoolOptions): pg.Pool {
  if (options.schema !== undefined && !SCHEMA_NAME.test(options.schema)) {
    throw new Error(`Invalid schema name "${options.schema}"`);
  }
  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const queryTimeoutMs = options.queryTimeoutMs ?? (statementTimeoutMs > 0 ? statementTimeoutMs + 10_000 : 0);
  const pool = new pg.Pool({
    connectionString,
    application_name: options.applicationName,
    max: options.max ?? 8,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    // Notices a peer that vanished (sleep, network change) on an idle connection.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    ...(queryTimeoutMs > 0 ? { query_timeout: queryTimeoutMs } : {}),
    options: [
      // Sessions run in UTC so timestamps never depend on the machine's zone.
      '-c timezone=UTC',
      `-c statement_timeout=${statementTimeoutMs}`,
      `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
      ...(options.schema ? [`-c search_path=${options.schema}`] : []),
    ].join(' '),
  });
  // An idle client can fail in the background (server restart, sleep/resume).
  // Without a listener that would crash the process; the next query reconnects.
  pool.on('error', () => undefined);
  return pool;
}

/**
 * Runs `work` in one transaction: commits if it resolves, rolls back if it
 * throws. A connection whose state is no longer known (the rollback failed,
 * or an answer never came) is destroyed instead of going back to the pool,
 * where the next caller would inherit it.
 */
export async function withTransaction<T>(pool: pg.Pool, work: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    broken = isQueryReadTimeout(error);
    if (!broken) {
      await client.query('ROLLBACK').catch(() => {
        broken = true;
      });
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

/** PostgreSQL error code, if the value is a database error. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export const PG_UNIQUE_VIOLATION = '23505';
export const PG_RESTRICT_VIOLATION = '23001';
