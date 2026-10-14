import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { COVERAGE_WINDOWS_HOURS, type EnabledMode } from '@morrow/core';
import Fastify, { type FastifyReply } from 'fastify';
import type pg from 'pg';
import type { Logger } from '../logging/logger.js';
import { createRedactor } from '../logging/redact.js';
import { buildCoverage } from './coverage.js';
import {
  EvidenceQueryError,
  getRawObservation,
  listEvents,
  listQuarantine,
  listRawObservations,
  parseCursor,
  parseFilter,
  parseId,
  parseLimit,
  parseSubject,
} from './evidence.js';
import { buildHealthReport } from './health.js';
import { ApiLogController } from './request-log.js';

/** The API listens here and nowhere else. It is not configurable. */
export const API_HOST = '127.0.0.1';

/** `apps/web/dist`, resolved from the compiled location of this file. */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

export interface ApiServerOptions {
  readonly pool: pg.Pool;
  readonly logger: Logger;
  readonly mode: EnabledMode;
  readonly version: string;
  readonly port: number;
  /** Folder holding the built dashboard. Skipped when it has no index.html. */
  readonly webRoot?: string;
  readonly migrationsDir?: string;
  /**
   * Removes known secrets from evidence text before it is served. Without
   * it, only credential-shaped patterns are removed.
   */
  readonly redact?: (text: string) => string;
}

/**
 * Builds the local API. Three things keep it local:
 *
 * - it binds to loopback only (see API_HOST);
 * - the Host header must name this server, which defeats DNS rebinding;
 * - a present Origin header must be this server, which stops other sites
 *   open in the operator's browser from calling it.
 *
 * Only reads exist in this build. Anything other than GET/HEAD is refused
 * outright; write endpoints must arrive together with session and CSRF
 * protection, not before.
 */
export async function buildApiServer(options: ApiServerOptions) {
  const app = Fastify({ loggerInstance: options.logger, logController: new ApiLogController() });

  const allowedHosts = new Set([`${API_HOST}:${options.port}`, `localhost:${options.port}`]);
  const allowedOrigins = new Set([`http://${API_HOST}:${options.port}`, `http://localhost:${options.port}`]);

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.toLowerCase();
    if (host === undefined || !allowedHosts.has(host)) {
      return reply.code(403).send({ error: 'HOST_NOT_ALLOWED' });
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return reply.code(403).send({ error: 'ORIGIN_NOT_ALLOWED' });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(405).send({ error: 'METHOD_NOT_ALLOWED' });
    }
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header(
      'content-security-policy',
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  app.get('/api/health', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return buildHealthReport({
      pool: options.pool,
      mode: options.mode,
      version: options.version,
      logger: options.logger,
      ...(options.migrationsDir !== undefined ? { migrationsDir: options.migrationsDir } : {}),
    });
  });

  app.get('/api/coverage', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const hours = Number((request.query as { hours?: unknown }).hours ?? 24);
    if (!(COVERAGE_WINDOWS_HOURS as readonly number[]).includes(hours)) {
      return reply.code(400).send({ error: 'UNSUPPORTED_WINDOW', allowed_hours: COVERAGE_WINDOWS_HOURS });
    }
    try {
      return await buildCoverage(options.pool, hours);
    } catch (error) {
      // The cause stays in the log; the page only needs to know there is no answer.
      options.logger.error({ err: error }, 'coverage query failed');
      return reply.code(503).send({ error: 'COVERAGE_UNAVAILABLE' });
    }
  });

  // Evidence browser (FT-01): read-only views of what was observed and what was made of it.
  const redact = options.redact ?? createRedactor([]);
  const evidence = async (reply: FastifyReply, work: () => Promise<unknown>): Promise<unknown> => {
    reply.header('cache-control', 'no-store');
    try {
      return await work();
    } catch (error) {
      if (error instanceof EvidenceQueryError) return reply.code(400).send({ error: error.error });
      options.logger.error({ err: error }, 'evidence query failed');
      return reply.code(503).send({ error: 'EVIDENCE_UNAVAILABLE' });
    }
  };
  type Query = Record<string, unknown>;
  app.get('/api/events', (request, reply) =>
    evidence(reply, () => {
      const query = request.query as Query;
      return listEvents(options.pool, {
        subject: parseSubject(query['subject']),
        before: parseCursor(query['before']),
        limit: parseLimit(query['limit']),
      });
    }),
  );
  app.get('/api/raw-observations', (request, reply) =>
    evidence(reply, () => {
      const query = request.query as Query;
      return listRawObservations(
        options.pool,
        {
          provider: parseFilter(query['provider']),
          capability: parseFilter(query['capability']),
          before: parseCursor(query['before']),
          limit: parseLimit(query['limit']),
        },
        redact,
      );
    }),
  );
  app.get('/api/raw-observations/:id', (request, reply) =>
    evidence(reply, async () => {
      const detail = await getRawObservation(options.pool, parseId((request.params as Query)['id']), redact);
      return detail ?? reply.code(404).send({ error: 'NOT_FOUND' });
    }),
  );
  app.get('/api/quarantine', (request, reply) =>
    evidence(reply, () => {
      const query = request.query as Query;
      return listQuarantine(
        options.pool,
        { reason: parseFilter(query['reason']), before: parseCursor(query['before']), limit: parseLimit(query['limit']) },
        redact,
      );
    }),
  );

  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  const hasDashboard = existsSync(path.join(webRoot, 'index.html'));
  if (hasDashboard) {
    await app.register(fastifyStatic, { root: webRoot });
  } else {
    options.logger.warn({ webRoot }, 'dashboard build not found; serving the API only');
  }

  app.setNotFoundHandler((request, reply) => {
    // Unknown pages fall back to the dashboard; unknown API routes do not.
    if (hasDashboard && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'NOT_FOUND' });
  });

  return app;
}
