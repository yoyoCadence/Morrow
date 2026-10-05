import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { EnabledMode } from '@morrow/core';
import Fastify from 'fastify';
import type pg from 'pg';
import type { Logger } from '../logging/logger.js';
import { buildHealthReport } from './health.js';

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
  const app = Fastify({ loggerInstance: options.logger });

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
