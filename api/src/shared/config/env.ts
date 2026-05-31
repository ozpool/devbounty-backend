// THIS IS THE ONLY FILE ALLOWED TO READ process.env
import { z } from 'zod';

const nodeEnvValues = ['development', 'test', 'production'] as const;

// In test mode many external services aren't available, so we provide safe
// defaults so modules can be imported without a full .env file.
const isTest = process.env['NODE_ENV'] === 'test';

function requiredInProd(fallback: string) {
  return isTest ? z.string().default(fallback) : z.string().min(1);
}

// Secrets must meet a minimum length in production so a weak/placeholder value
// can never ship. In test the fallback is used as-is.
function secretInProd(minLength: number, fallback: string) {
  return isTest ? z.string().default(fallback) : z.string().min(minLength);
}

// The schema is split into per-domain slices so a feature PR only touches its
// own slice (auth, chain, github, ...) instead of editing one monolithic object.
// Add a new domain by defining a slice below and merging it into `schema`.

const runtimeEnv = z.object({
  NODE_ENV: z.enum(nodeEnvValues).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(4000),
});

const databaseEnv = z.object({
  // Required in production, defaulted in test.
  MONGO_URI: requiredInProd('mongodb://localhost:27017/devbounty_test'),
});

const authEnv = z.object({
  // HS256 signing key — at least 32 chars of entropy in production.
  JWT_SECRET: secretInProd(32, 'test-jwt-secret-not-for-production'),
  JWT_COOKIE_NAME: z.string().default('devbounty_jwt'),
  JWT_TTL: z.string().default('7d'), // session lifetime, e.g. 7d / 12h / 3600
});

const chainEnv = z.object({
  // No hardcoded addresses here; they come from env.
  CHAIN_ID: z.coerce.number().int().positive().default(421614),
  RPC_URL_HTTP: requiredInProd('http://localhost:8545'),
  RPC_URL_HTTP_FALLBACK: z.string().optional(),
});

const servicesEnv = z.object({
  // Bearer token for /health/internal — at least 16 chars in production.
  INTERNAL_HEALTH_TOKEN: secretInProd(16, 'test-internal-token'),
  // Public base URL (used to build webhook callback URLs in later issues).
  API_PUBLIC_BASE_URL: requiredInProd('http://localhost:4000'),
  // Strict CORS origin — the web frontend origin.
  CORS_ORIGIN: requiredInProd('http://localhost:3000'),
});

const monitoringEnv = z.object({
  // Optional; Sentry is a no-op when absent.
  SENTRY_DSN: z.string().optional(),
});

const encryptionEnv = z.object({
  // Encryption at rest for tokens/secrets (AES-256-GCM). Keys are 32-byte values
  // in hex. Versioning enables rotation: new writes use the active version; old
  // blobs decrypt by the version stored alongside them.
  ENC_ACTIVE_KEY_VERSION: z.string().default('v1'),
  ENC_KEY_V1: requiredInProd('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'),
  ENC_KEY_V2: z.string().optional(),
});

const githubEnv = z.object({
  // GitHub OAuth app credentials for account linking. The callback URL is derived
  // from API_PUBLIC_BASE_URL.
  GITHUB_OAUTH_CLIENT_ID: requiredInProd('test-github-client-id'),
  GITHUB_OAUTH_CLIENT_SECRET: requiredInProd('test-github-client-secret'),
  GITHUB_OAUTH_SCOPES: z.string().default('read:user repo'),
});

const schema = runtimeEnv
  .merge(databaseEnv)
  .merge(authEnv)
  .merge(chainEnv)
  .merge(servicesEnv)
  .merge(monitoringEnv)
  .merge(encryptionEnv)
  .merge(githubEnv);

export type Env = z.infer<typeof schema>;

/**
 * Parse a raw env object. Exported for unit testing with fake inputs.
 * Throws ZodError on invalid input — callers decide how to handle.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  return schema.parse(raw);
}

function loadEnv(): Readonly<Env> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // Use process.stderr directly — logger depends on env, can't use it here
    process.stderr.write(`[env] Invalid environment configuration:\n${result.error.toString()}\n`);
    process.exit(1);
  }
  return Object.freeze(result.data);
}

export const env: Readonly<Env> = loadEnv();
