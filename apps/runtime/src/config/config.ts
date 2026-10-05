import { requireEnabledMode, type EnabledMode } from '@morrow/core';
import { z } from 'zod';

const ENV_PREFIX = 'MORROW_';

/** A provider credential. The minimum length keeps value-based log redaction from matching ordinary words. */
const Secret = z.string().min(8, 'must be at least 8 characters');

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Every setting the runtime reads. The object is strict: an unrecognised
 * MORROW_* variable stops startup instead of being ignored, so a typo cannot
 * silently fall back to a default and nothing like a signer key can be slipped
 * in under a name this build does not know.
 */
const EnvSchema = z.strictObject({
  MORROW_MODE: z.string().default('OFF'),
  MORROW_DATABASE_URL: z.string().min(1),
  /** Used only by the test suite. Listed here so a shared .env passes validation. */
  MORROW_TEST_DATABASE_URL: z.string().min(1).optional(),
  MORROW_API_PORT: z.coerce.number().int().min(1024).max(65535).default(8787),
  MORROW_LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  MORROW_JUPITER_API_KEY: Secret.optional(),
  MORROW_HELIUS_API_KEY: Secret.optional(),
  MORROW_OKX_API_KEY: Secret.optional(),
  MORROW_OKX_SECRET_KEY: Secret.optional(),
  MORROW_OKX_PASSPHRASE: Secret.optional(),
});

export interface ProviderCredentials {
  readonly jupiter?: { readonly apiKey: string };
  readonly helius?: { readonly apiKey: string };
  readonly okx?: { readonly apiKey: string; readonly secretKey: string; readonly passphrase: string };
}

export interface AppConfig {
  readonly mode: EnabledMode;
  readonly databaseUrl: string;
  readonly apiPort: number;
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly credentials: ProviderCredentials;
  /** Every secret string in this configuration, for log redaction. Never log this. */
  readonly secretValues: readonly string[];
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function databasePassword(url: string, variable: string, problems: string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    problems.push(`${variable}: not a valid URL`);
    return undefined;
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    problems.push(`${variable}: expected a postgres:// URL`);
    return undefined;
  }
  return parsed.password === '' ? undefined : decodeURIComponent(parsed.password);
}

/**
 * Builds the configuration from environment variables.
 *
 * Throws ConfigError for malformed settings and ModeNotEnabledError when a
 * mode beyond PAPER is requested. Messages name variables and never include
 * their values.
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const relevant: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    // An empty value in a .env file means "not set".
    if (name.startsWith(ENV_PREFIX) && value !== undefined && value !== '') relevant[name] = value;
  }

  const parsed = EnvSchema.safeParse(relevant);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      if (issue.code === 'unrecognized_keys') return `unrecognised setting(s): ${issue.keys.join(', ')}`;
      const variable = issue.path.join('.') || 'environment';
      return issue.code === 'invalid_type' && relevant[variable] === undefined
        ? `${variable}: required but not set`
        : `${variable}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  const values = parsed.data;

  // Checked before anything else can use the configuration.
  const mode = requireEnabledMode(values.MORROW_MODE);

  const problems: string[] = [];
  const secrets: string[] = [];

  const dbPassword = databasePassword(values.MORROW_DATABASE_URL, 'MORROW_DATABASE_URL', problems);
  if (dbPassword !== undefined) secrets.push(dbPassword);
  if (values.MORROW_TEST_DATABASE_URL !== undefined) {
    const testPassword = databasePassword(values.MORROW_TEST_DATABASE_URL, 'MORROW_TEST_DATABASE_URL', problems);
    if (testPassword !== undefined) secrets.push(testPassword);
  }

  const okxParts = [values.MORROW_OKX_API_KEY, values.MORROW_OKX_SECRET_KEY, values.MORROW_OKX_PASSPHRASE];
  const okxSet = okxParts.filter((part) => part !== undefined).length;
  if (okxSet !== 0 && okxSet !== 3) {
    problems.push('MORROW_OKX_API_KEY, MORROW_OKX_SECRET_KEY and MORROW_OKX_PASSPHRASE must be set together');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const credentials: {
    jupiter?: ProviderCredentials['jupiter'];
    helius?: ProviderCredentials['helius'];
    okx?: ProviderCredentials['okx'];
  } = {};
  if (values.MORROW_JUPITER_API_KEY !== undefined) {
    credentials.jupiter = { apiKey: values.MORROW_JUPITER_API_KEY };
    secrets.push(values.MORROW_JUPITER_API_KEY);
  }
  if (values.MORROW_HELIUS_API_KEY !== undefined) {
    credentials.helius = { apiKey: values.MORROW_HELIUS_API_KEY };
    secrets.push(values.MORROW_HELIUS_API_KEY);
  }
  if (
    values.MORROW_OKX_API_KEY !== undefined &&
    values.MORROW_OKX_SECRET_KEY !== undefined &&
    values.MORROW_OKX_PASSPHRASE !== undefined
  ) {
    credentials.okx = {
      apiKey: values.MORROW_OKX_API_KEY,
      secretKey: values.MORROW_OKX_SECRET_KEY,
      passphrase: values.MORROW_OKX_PASSPHRASE,
    };
    secrets.push(values.MORROW_OKX_API_KEY, values.MORROW_OKX_SECRET_KEY, values.MORROW_OKX_PASSPHRASE);
  }

  return {
    mode,
    databaseUrl: values.MORROW_DATABASE_URL,
    apiPort: values.MORROW_API_PORT,
    logLevel: values.MORROW_LOG_LEVEL,
    credentials,
    secretValues: secrets,
  };
}
