import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../shared/utils/AppError.js';

// Mock logger and sentry before importing the middleware so pino-http
// doesn't try to spin up a pretty-printer in test
vi.mock('../shared/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  httpLogger: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));

vi.mock('../shared/utils/sentry.js', () => ({
  initSentry: vi.fn(),
  captureException: vi.fn(),
}));

// Import after mocks are registered
const { errorMiddleware } = await import('../api/middleware/error.js');
const { captureException } = await import('../shared/utils/sentry.js');

function makeRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json, _json: json } as unknown as Response & {
    status: ReturnType<typeof vi.fn>;
    _json: ReturnType<typeof vi.fn>;
  };
}

function makeReq() {
  return {} as Request;
}

const next: NextFunction = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('errorMiddleware — AppError', () => {
  it('responds with AppError statusCode and sanitized body', () => {
    const res = makeRes();
    const err = AppError.notFound('bounty not found');

    errorMiddleware(err, makeReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(404);
    const jsonArg = (res.status as ReturnType<typeof vi.fn>).mock.results[0]?.value as {
      json: ReturnType<typeof vi.fn>;
    };
    expect(jsonArg.json).toHaveBeenCalledWith({
      code: 'NOT_FOUND',
      message: 'bounty not found',
    });
  });

  it('does not call captureException for operational AppErrors', () => {
    const res = makeRes();
    errorMiddleware(AppError.badRequest('bad'), makeReq(), res, next);
    expect(captureException).not.toHaveBeenCalled();
  });

  it('uses AppError.unauthorized statusCode 401', () => {
    const res = makeRes();
    errorMiddleware(AppError.unauthorized(), makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('errorMiddleware — unknown error', () => {
  it('responds 500 with generic message, never leaking internals', () => {
    const res = makeRes();
    const secret = 'super-secret-db-password-abc123';
    const err = new Error(`DB connection failed: ${secret}`);

    errorMiddleware(err, makeReq(), res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    const jsonArg = (res.status as ReturnType<typeof vi.fn>).mock.results[0]?.value as {
      json: ReturnType<typeof vi.fn>;
    };
    const body = jsonArg.json.mock.calls[0]?.[0] as Record<string, unknown>;

    // Generic message only — no stack, no internal detail
    expect(body['code']).toBe('INTERNAL_ERROR');
    expect(body['message']).toBe('An unexpected error occurred');
    // Must NOT contain the secret or the original error message
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain('DB connection failed');
  });

  it('does not include stack trace in response body', () => {
    const res = makeRes();
    const err = new Error('some error');

    errorMiddleware(err, makeReq(), res, next);

    const jsonArg = (res.status as ReturnType<typeof vi.fn>).mock.results[0]?.value as {
      json: ReturnType<typeof vi.fn>;
    };
    const body = jsonArg.json.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty('stack');
  });

  it('calls captureException for unknown errors', () => {
    const res = makeRes();
    const err = new TypeError('unexpected');
    errorMiddleware(err, makeReq(), res, next);
    expect(captureException).toHaveBeenCalledWith(err);
  });

  it('handles non-Error thrown values (string, plain object)', () => {
    const res = makeRes();
    errorMiddleware('something broke', makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
