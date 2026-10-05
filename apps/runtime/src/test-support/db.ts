import { randomBytes } from 'node:crypto';
import type { TestContext } from 'node:test';
import type pg from 'pg';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { createLogger, type Logger } from '../logging/logger.js';

export interface TestDb {
  readonly pool: pg.Pool;
  readonly url: string;
  readonly schema: string;
  close(): Promise<void>;
}

/**
 * Gives a test file its own empty schema in the test database, migrated
 * unless asked otherwise, and drops it on close. Files run in parallel
 * processes, so each needs its own.
 *
 * The database name must end in `_test`. That rule is the guard against
 * pointing the suite at real data.
 */
export async function createTestDb(options: { migrate?: boolean } = {}): Promise<TestDb> {
  const url = process.env.MORROW_TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'MORROW_TEST_DATABASE_URL is not set. Database tests need a disposable PostgreSQL database; see README.md.',
    );
  }
  const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!databaseName.endsWith('_test')) {
    throw new Error('Refusing to run database tests: the database name in MORROW_TEST_DATABASE_URL must end in "_test".');
  }

  const schema = `t_${randomBytes(6).toString('hex')}`;
  // The pool's search_path may name a schema before it exists, so the same
  // pool can create it. Opening a second connection just for that is slow on
  // Windows, where every PostgreSQL connection is a new process.
  const pool = createPool(url, { applicationName: 'morrow-test', schema });
  await pool.query(`CREATE SCHEMA ${schema}`);
  if (options.migrate !== false) await migrate(pool);

  return {
    pool,
    url,
    schema,
    async close() {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}

const deferred = new WeakMap<TestContext, Array<() => unknown>>();

/**
 * Registers cleanup for a test, run in reverse order of registration: what
 * was set up last is torn down first, so a process is stopped before the
 * database it uses is closed.
 */
export function defer(t: TestContext, cleanup: () => unknown): void {
  let stack = deferred.get(t);
  if (!stack) {
    const created: Array<() => unknown> = [];
    stack = created;
    deferred.set(t, created);
    t.after(async () => {
      for (const step of created.reverse()) await step();
    });
  }
  stack.push(cleanup);
}

export const silentLogger: Logger =createLogger({ level: 'silent', component: 'test', redact: (text) => text });

/** A logger that keeps what it writes, plus a way to read it back. */
export function capturingLogger(redact: (text: string) => string): { logger: Logger; output: () => string } {
  const lines: string[] = [];
  const logger = createLogger({
    level: 'trace',
    component: 'test',
    redact,
    destination: { write: (line: string) => void lines.push(line) },
  });
  return { logger, output: () => lines.join('') };
}

/** Rejects unless `work` rejects with the given PostgreSQL error code. */
export async function expectPgError(work: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await work();
  } catch (error) {
    const actual = (error as { code?: unknown }).code;
    if (actual === code) return;
    throw new Error(`Expected PostgreSQL error ${code}, got ${String(actual)}: ${String(error)}`);
  }
  throw new Error(`Expected PostgreSQL error ${code}, but the statement succeeded`);
}
