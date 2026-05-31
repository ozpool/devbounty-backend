export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  override readonly message: string;
  override readonly cause: unknown;
  /** True for all AppError instances — distinguishes operational errors from bugs. */
  readonly isOperational = true;

  constructor(opts: { statusCode: number; code: string; message: string; cause?: unknown }) {
    super(opts.message);
    this.name = 'AppError';
    this.statusCode = opts.statusCode;
    this.code = opts.code;
    this.message = opts.message;
    this.cause = opts.cause;

    // Restore prototype chain (needed when targeting ES5/ES2015 with extends)
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static notFound(message = 'Not found', cause?: unknown): AppError {
    return new AppError({ statusCode: 404, code: 'NOT_FOUND', message, cause });
  }

  static unauthorized(message = 'Unauthorized', cause?: unknown): AppError {
    return new AppError({ statusCode: 401, code: 'UNAUTHORIZED', message, cause });
  }

  static forbidden(message = 'Forbidden', cause?: unknown): AppError {
    return new AppError({ statusCode: 403, code: 'FORBIDDEN', message, cause });
  }

  static badRequest(message: string, cause?: unknown): AppError {
    return new AppError({ statusCode: 400, code: 'BAD_REQUEST', message, cause });
  }

  static conflict(message: string, cause?: unknown): AppError {
    return new AppError({ statusCode: 409, code: 'CONFLICT', message, cause });
  }

  static internal(message = 'Internal server error', cause?: unknown): AppError {
    return new AppError({ statusCode: 500, code: 'INTERNAL_ERROR', message, cause });
  }
}
