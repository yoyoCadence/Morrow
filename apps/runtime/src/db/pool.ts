import pg from 'pg';

/** Anything a query can be run on: the pool, or one client inside a transaction. */
export type Queryable = pg.Pool | pg.PoolClient;

export interface PoolOptions {
  readonly applicationName: string;
  /** Schema to resolve unqualified names in. Used by tests to isolate each file. */
  readonly schema?: string;
  readonly max?: number;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function createPool(connectionString: string, options: PoolOptions): pg.Pool {
  if (options.schema !== undefined && !SCHEMA_NAME.test(options.schema)) {
    throw new Error(`Invalid schema name "${options.schema}"`);
  }
  const pool = new pg.Pool({
    connectionString,
    application_name: options.applicationName,
    max: options.max ?? 8,
    // Sessions run in UTC so timestamps never depend on the machine's zone.
    options: ['-c timezone=UTC', ...(options.schema ? [`-c search_path=${options.schema}`] : [])].join(' '),
  });
  // An idle client can fail in the background (server restart, sleep/resume).
  // Without a listener that would crash the process; the next query reconnects.
  pool.on('error', () => undefined);
  return pool;
}

/** Runs `work` in one transaction: commits if it resolves, rolls back if it throws. */
export async function withTransaction<T>(pool: pg.Pool, work: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
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
