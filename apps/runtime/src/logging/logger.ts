import { destination, pino, type DestinationStream, type Logger } from 'pino';
import { REDACTED } from './redact.js';

export type { Logger };

export interface LoggerOptions {
  readonly level: string;
  readonly component: string;
  /** Applied to every serialised log line just before it is written. */
  readonly redact: (text: string) => string;
  /** Defaults to stdout. Tests pass a capturing stream. */
  readonly destination?: DestinationStream;
}

/**
 * Structured JSON logger. Redaction happens on the final serialised line, so
 * it covers messages, nested objects and error stacks alike, with no reliance
 * on callers remembering which fields are sensitive.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { component: options.component },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie'],
        censor: REDACTED,
      },
      hooks: { streamWrite: options.redact },
    },
    options.destination ?? destination({ dest: 1, sync: true }),
  );
}
