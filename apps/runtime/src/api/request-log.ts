import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';

export type RequestLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * How much a finished request matters to the operator.
 *
 * - error: the server failed (5xx, or the response itself errored).
 * - warn: refused by the Host or Origin check (403). Something other than
 *   the dashboard tried to reach the API: DNS rebinding, or another site
 *   open in the browser.
 * - info: any other refusal (404, 405, ...) and every request that is not a
 *   read. Unusual for the dashboard, so worth a line.
 * - debug: a successful read. The dashboard polls health all day long, so
 *   these are hidden at the default level.
 */
export function requestLogLevel(method: string, statusCode: number, failed: boolean): RequestLogLevel {
  if (failed || statusCode >= 500) return 'error';
  if (statusCode === 403) return 'warn';
  if (statusCode >= 400 || (method !== 'GET' && method !== 'HEAD')) return 'info';
  return 'debug';
}

/**
 * Writes one line per request, when it completes, at the level chosen by
 * `requestLogLevel`. Fastify's default is two `info` lines per request
 * (incoming and completed), which buries everything else under health polls.
 * The line carries the request (method, url, host, remote address), the
 * status code and the response time, so the incoming line is not needed.
 */
export class ApiLogController extends LogController {
  override incomingRequest(): void {}

  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    const level = requestLogLevel(request.method, reply.statusCode, error != null);
    const line = { req: request, res: reply, responseTime: reply.elapsedTime };
    if (error != null) reply.log[level]({ ...line, err: error }, 'request errored');
    else reply.log[level](line, 'request completed');
  }
}
