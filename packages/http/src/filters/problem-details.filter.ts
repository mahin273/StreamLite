import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ZodError } from 'zod';
import type { ProblemDetails, FieldError } from '@streamlite/contracts';
import { getRequestId, logger } from '@streamlite/logger';
import { AppError } from '../errors/app-error.js';

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const requestId = getRequestId();

    const problem = this.formatProblemDetails(exception, requestId);

    // Structured logging with level based on status code
    if (problem.status >= 500) {
      logger.error(
        {
          err: exception,
          requestId: problem.requestId,
          status: problem.status,
          code: problem.code,
        },
        problem.detail,
      );
    } else {
      logger.warn(
        {
          requestId: problem.requestId,
          status: problem.status,
          code: problem.code,
          errors: problem.errors,
        },
        problem.detail,
      );
    }

    // Set standard RFC 7807 header
    if (typeof response.header === 'function') {
      response.header('Content-Type', 'application/problem+json');
    } else if (typeof response.setHeader === 'function') {
      response.setHeader('Content-Type', 'application/problem+json');
    }

    // Support both Fastify (.send) and Express (.json)
    if (typeof response.status === 'function') {
      response.status(problem.status);
    }

    if (typeof response.send === 'function') {
      response.send(problem);
    } else if (typeof response.json === 'function') {
      response.json(problem);
    }
  }

  private formatProblemDetails(exception: unknown, requestId?: string): ProblemDetails {
    // 1. Domain AppError
    if (exception instanceof AppError) {
      return {
        type: exception.type,
        title: exception.title,
        status: exception.statusCode,
        detail: exception.detail,
        code: exception.code,
        ...(requestId ? { requestId } : {}),
        ...(exception.errors ? { errors: exception.errors } : {}),
      };
    }

    // 2. Zod Validation Error
    if (exception instanceof ZodError) {
      const fieldErrors: FieldError[] = exception.issues.map((issue) => ({
        field: issue.path.join('.') || 'body',
        message: issue.message,
      }));

      return {
        type: 'https://streamlite.dev/errors/validation-error',
        title: 'Validation Failed',
        status: HttpStatus.BAD_REQUEST,
        detail: 'One or more request validation constraints failed',
        code: 'VALIDATION_ERROR',
        ...(requestId ? { requestId } : {}),
        errors: fieldErrors,
      };
    }

    // 3. NestJS Built-in HttpException
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      let detail = exception.message;
      let errors: FieldError[] | undefined;

      if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, unknown>;
        if (typeof resObj['message'] === 'string') {
          detail = resObj['message'];
        } else if (Array.isArray(resObj['message'])) {
          errors = resObj['message'].map((msg) => ({
            field: 'request',
            message: String(msg),
          }));
        }
      }

      const code = HttpStatus[status] || 'HTTP_ERROR';

      return {
        type: `https://streamlite.dev/errors/${code.toLowerCase().replace(/_/g, '-')}`,
        title: HttpStatus[status] || 'HTTP Exception',
        status,
        detail,
        code,
        ...(requestId ? { requestId } : {}),
        ...(errors ? { errors } : {}),
      };
    }

    // 4. Unknown Unhandled Error (Sanitized 500)
    return {
      type: 'https://streamlite.dev/errors/internal-error',
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'An unexpected internal server error occurred',
      code: 'INTERNAL_ERROR',
      ...(requestId ? { requestId } : {}),
    };
  }
}
