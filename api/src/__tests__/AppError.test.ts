import { describe, it, expect } from 'vitest';
import { AppError } from '../shared/utils/AppError.js';

describe('AppError', () => {
  it('constructs with correct shape', () => {
    const err = new AppError({ statusCode: 422, code: 'VALIDATION', message: 'bad input' });
    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toBe('bad input');
    expect(err.cause).toBeUndefined();
    expect(err instanceof Error).toBe(true);
    expect(err instanceof AppError).toBe(true);
    expect(err.name).toBe('AppError');
  });

  it('isOperational is always true', () => {
    const err = new AppError({ statusCode: 400, code: 'BAD_REQUEST', message: 'bad' });
    expect(err.isOperational).toBe(true);
  });

  it('stores cause', () => {
    const cause = new Error('root');
    const err = new AppError({ statusCode: 500, code: 'X', message: 'm', cause });
    expect(err.cause).toBe(cause);
  });

  it('notFound returns 404 NOT_FOUND', () => {
    const err = AppError.notFound();
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe('NOT_FOUND');
  });

  it('notFound accepts custom message', () => {
    const err = AppError.notFound('bounty not found');
    expect(err.message).toBe('bounty not found');
  });

  it('unauthorized returns 401 UNAUTHORIZED', () => {
    const err = AppError.unauthorized();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('forbidden returns 403 FORBIDDEN', () => {
    const err = AppError.forbidden();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });

  it('badRequest returns 400 BAD_REQUEST', () => {
    const err = AppError.badRequest('missing field');
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.message).toBe('missing field');
  });

  it('conflict returns 409 CONFLICT', () => {
    const err = AppError.conflict('already exists');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('CONFLICT');
  });

  it('internal returns 500 INTERNAL_ERROR', () => {
    const err = AppError.internal();
    expect(err.statusCode).toBe(500);
    expect(err.code).toBe('INTERNAL_ERROR');
  });

  it('instanceof check survives prototype chain restore', () => {
    const err = AppError.notFound();
    expect(err instanceof AppError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });
});
