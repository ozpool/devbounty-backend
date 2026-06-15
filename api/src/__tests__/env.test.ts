import { describe, it, expect } from 'vitest';
import { parseEnv } from '../shared/config/env.js';

// Test the pure parseEnv() function — no process.exit path touched.

const base = {
  NODE_ENV: 'test',
  MONGO_URI: 'mongodb://localhost:27017/test',
  JWT_SECRET: 'secret',
  RPC_URL_HTTP: 'http://localhost:8545',
  INTERNAL_HEALTH_TOKEN: 'tok',
  API_PUBLIC_BASE_URL: 'http://localhost:4000',
  CORS_ORIGIN: 'http://localhost:3000',
};

describe('parseEnv', () => {
  it('parses a valid env object', () => {
    const result = parseEnv(base);
    expect(result.NODE_ENV).toBe('test');
    expect(result.PORT).toBe(4000); // default
    expect(result.CHAIN_ID).toBe(421614); // default
    expect(result.JWT_COOKIE_NAME).toBe('devbounty_jwt'); // default
    expect(result.LOG_LEVEL).toBe('info'); // default
  });

  it('accepts explicit PORT override', () => {
    const result = parseEnv({ ...base, PORT: '5000' });
    expect(result.PORT).toBe(5000);
  });

  it('accepts all valid NODE_ENV values', () => {
    for (const env of ['development', 'test', 'production'] as const) {
      const result = parseEnv({ ...base, NODE_ENV: env });
      expect(result.NODE_ENV).toBe(env);
    }
  });

  it('rejects invalid NODE_ENV', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'staging' })).toThrow();
  });

  it('rejects invalid LOG_LEVEL', () => {
    expect(() => parseEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow();
  });

  it('rejects non-numeric PORT', () => {
    expect(() => parseEnv({ ...base, PORT: 'not-a-port' })).toThrow();
  });

  it('coerces PORT from string to number', () => {
    const result = parseEnv({ ...base, PORT: '8080' });
    expect(result.PORT).toBe(8080);
  });

  it('defaults CHAIN_ID to 421614 when absent', () => {
    const result = parseEnv(base);
    expect(result.CHAIN_ID).toBe(421614);
  });

  it('RPC_URL_HTTP_FALLBACK is optional', () => {
    const result = parseEnv(base);
    expect(result.RPC_URL_HTTP_FALLBACK).toBeUndefined();
  });

  it('accepts RPC_URL_HTTP_FALLBACK when provided', () => {
    const result = parseEnv({ ...base, RPC_URL_HTTP_FALLBACK: 'http://fallback' });
    expect(result.RPC_URL_HTTP_FALLBACK).toBe('http://fallback');
  });

  it('SENTRY_DSN is optional', () => {
    const result = parseEnv(base);
    expect(result.SENTRY_DSN).toBeUndefined();
  });

  it('accepts SENTRY_DSN when provided', () => {
    const result = parseEnv({ ...base, SENTRY_DSN: 'https://abc@o123.ingest.sentry.io/456' });
    expect(result.SENTRY_DSN).toBe('https://abc@o123.ingest.sentry.io/456');
  });
});
