import { describe, it, expect } from 'vitest';
import pino from 'pino';

// Test that pino's redact config actually censors sensitive fields.
// We build a logger with the same redact config as our production logger
// and write to an in-memory stream so we can inspect the JSON output.

const redactPaths = [
  '*.privateKey',
  '*.password',
  '*.token',
  '*.secret',
  '*.signature',
  '*.authorization',
  '*.cookie',
  '*.webhookSecret',
  '*.encryptedToken',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.headers.authorization',
  '*.headers.cookie',
];

function buildTestLogger() {
  const lines: string[] = [];
  const stream = {
    write(line: string) {
      lines.push(line);
    },
  };
  const log = pino(
    {
      level: 'info',
      redact: { paths: redactPaths, censor: '[Redacted]' },
    },
    stream,
  );
  return { log, lines };
}

function lastParsed(lines: string[]): Record<string, unknown> {
  const last = lines[lines.length - 1];
  if (!last) throw new Error('No log lines captured');
  return JSON.parse(last) as Record<string, unknown>;
}

describe('logger redaction', () => {
  it('redacts privateKey', () => {
    const { log, lines } = buildTestLogger();
    log.info({ wallet: { privateKey: '0xdeadbeef' } }, 'test');
    const out = lastParsed(lines);
    expect((out['wallet'] as Record<string, unknown>)['privateKey']).toBe('[Redacted]');
  });

  it('redacts authorization header', () => {
    const { log, lines } = buildTestLogger();
    log.info({ req: { headers: { authorization: 'Bearer secret-token' } } }, 'test');
    const out = lastParsed(lines);
    const req = out['req'] as Record<string, unknown>;
    const headers = req['headers'] as Record<string, unknown>;
    expect(headers['authorization']).toBe('[Redacted]');
  });

  it('redacts cookie header', () => {
    const { log, lines } = buildTestLogger();
    log.info({ req: { headers: { cookie: 'devbounty_jwt=abc123' } } }, 'test');
    const out = lastParsed(lines);
    const req = out['req'] as Record<string, unknown>;
    const headers = req['headers'] as Record<string, unknown>;
    expect(headers['cookie']).toBe('[Redacted]');
  });

  it('redacts token on any object', () => {
    const { log, lines } = buildTestLogger();
    log.info({ session: { token: 'my-jwt' } }, 'test');
    const out = lastParsed(lines);
    expect((out['session'] as Record<string, unknown>)['token']).toBe('[Redacted]');
  });

  it('redacts password on any object', () => {
    const { log, lines } = buildTestLogger();
    log.info({ user: { password: 'hunter2' } }, 'test');
    const out = lastParsed(lines);
    expect((out['user'] as Record<string, unknown>)['password']).toBe('[Redacted]');
  });

  it('redacts secret on any object', () => {
    const { log, lines } = buildTestLogger();
    log.info({ config: { secret: 'my-secret-value' } }, 'test');
    const out = lastParsed(lines);
    expect((out['config'] as Record<string, unknown>)['secret']).toBe('[Redacted]');
  });

  it('redacts encryptedToken on any object', () => {
    const { log, lines } = buildTestLogger();
    log.info({ record: { encryptedToken: 'base64blob' } }, 'test');
    const out = lastParsed(lines);
    expect((out['record'] as Record<string, unknown>)['encryptedToken']).toBe('[Redacted]');
  });

  it('does NOT redact non-sensitive fields', () => {
    const { log, lines } = buildTestLogger();
    log.info({ user: { address: '0xabc', role: 'hunter' } }, 'test');
    const out = lastParsed(lines);
    const user = out['user'] as Record<string, unknown>;
    expect(user['address']).toBe('0xabc');
    expect(user['role']).toBe('hunter');
  });
});
