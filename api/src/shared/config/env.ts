// THIS IS THE ONLY FILE ALLOWED TO READ process.env
import { z } from 'zod';

const nodeEnvValues = ['development', 'test', 'production'] as const;

// In test mode many external services aren't available, so we provide safe
// defaults so modules can be imported without a full .env file.
const isTest = process.env['NODE_ENV'] === 'test';

function requiredInProd(fallback: string) {
  return isTest ? z.string().default(fallback) : z.string().min(1);
}

const schema = z.object({
  NODE_ENV: z.enum(nodeEnvValues).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(4000),

  // Database — required in production, defaulted in test
  MONGO_URI: requiredInProd('mongodb://localhost:27017/devbounty_test'),

  // Auth
  JWT_SECRET: requiredInProd('test-jwt-secret-not-for-production'),
  JWT_COOKIE_NAME: z.string().default('devbounty_jwt'),

  // Chain — no hardcoded addresses here; come from env
  CHAIN_ID: z.coerce.number().int().positive().default(421614),
  RPC_URL_HTTP: requiredInProd('http://localhost:8545'),
  RPC_URL_HTTP_FALLBACK: z.string().optional(),

  // Internal
  INTERNAL_HEALTH_TOKEN: requiredInProd('test-internal-token'),

  // Public base URL (used to build webhook callback URLs in later issues)
  API_PUBLIC_BASE_URL: requiredInProd('http://localhost:4000'),

  // Strict CORS origin — the web frontend origin
  CORS_ORIGIN: requiredInProd('http://localhost:3000'),

  // Monitoring — optional; Sentry is a no-op when absent
  SENTRY_DSN: z.string().optional(),
});

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
