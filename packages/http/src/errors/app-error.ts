import type { FieldError } from '@streamlite/contracts';

export interface AppErrorOptions {
  statusCode: number;
  title: string;
  detail: string;
  code: string;
  type?: string | undefined;
  errors?: FieldError[] | undefined;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly title: string;
  public readonly detail: string;
  public readonly code: string;
  public readonly type: string;
  public readonly errors?: FieldError[] | undefined;

  constructor(options: AppErrorOptions) {
    super(options.detail);
    this.name = this.constructor.name;
    this.statusCode = options.statusCode;
    this.title = options.title;
    this.detail = options.detail;
    this.code = options.code;
    this.type =
      options.type ||
      `https://streamlite.dev/errors/${options.code.toLowerCase().replace(/_/g, '-')}`;
    if (options.errors && options.errors.length > 0) {
      this.errors = options.errors;
    }

    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends AppError {
  constructor(detail = 'The request payload is invalid', errors?: FieldError[]) {
    super({
      statusCode: 400,
      title: 'Bad Request',
      detail,
      code: 'BAD_REQUEST',
      type: 'https://streamlite.dev/errors/bad-request',
      ...(errors ? { errors } : {}),
    });
  }
}

export class ValidationError extends AppError {
  constructor(detail = 'Validation failed for one or more fields', errors?: FieldError[]) {
    super({
      statusCode: 400,
      title: 'Validation Failed',
      detail,
      code: 'VALIDATION_ERROR',
      type: 'https://streamlite.dev/errors/validation-error',
      ...(errors ? { errors } : {}),
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail = 'Authentication is required to access this resource') {
    super({
      statusCode: 401,
      title: 'Unauthorized',
      detail,
      code: 'UNAUTHORIZED',
      type: 'https://streamlite.dev/errors/unauthorized',
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'You do not have sufficient permissions to access this resource') {
    super({
      statusCode: 403,
      title: 'Forbidden',
      detail,
      code: 'FORBIDDEN',
      type: 'https://streamlite.dev/errors/forbidden',
    });
  }
}

export class NotFoundError extends AppError {
  constructor(detail = 'The requested resource was not found') {
    super({
      statusCode: 404,
      title: 'Resource Not Found',
      detail,
      code: 'NOT_FOUND',
      type: 'https://streamlite.dev/errors/not-found',
    });
  }
}

export class ConflictError extends AppError {
  constructor(detail = 'The resource already exists or conflicts with the current state') {
    super({
      statusCode: 409,
      title: 'Conflict',
      detail,
      code: 'CONFLICT',
      type: 'https://streamlite.dev/errors/conflict',
    });
  }
}

export class InternalServerError extends AppError {
  constructor(detail = 'An unexpected internal server error occurred') {
    super({
      statusCode: 500,
      title: 'Internal Server Error',
      detail,
      code: 'INTERNAL_ERROR',
      type: 'https://streamlite.dev/errors/internal-error',
    });
  }
}
