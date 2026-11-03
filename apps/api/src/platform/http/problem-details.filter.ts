import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { isDomainError } from '@shipkeep/domain';
import type { Request, Response } from 'express';

import {
  type FieldError,
  KIND_STATUS,
  PROBLEM_CODES,
  PROBLEM_MEDIA_TYPE,
  type ProblemDetails,
  problemType,
  statusCode,
  statusTitle,
} from './problem-details';

/** Thrown by the validation pipe; carries field-level errors. */
export class ValidationProblem extends HttpException {
  constructor(readonly fieldErrors: readonly FieldError[]) {
    super('request validation failed', HttpStatus.BAD_REQUEST);
  }
}

/**
 * Maps every error to an RFC 9457 problem details response. Domain errors keep their code and
 * message; HTTP exceptions keep their status; anything else becomes an opaque 500 so that
 * internal messages (which might embed secrets or paths) never reach the client.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: unknown }>();
    const response = http.getResponse<Response>();

    const problem = this.toProblem(exception, request);
    if (problem.status >= 500) {
      // Deliberate 5xx (for example 503 from the readiness probe) are expected conditions;
      // anything else is a bug and gets the full error for diagnosis.
      if (exception instanceof HttpException) {
        this.logger.warn({ requestId: problem.requestId, path: request.url }, problem.detail);
      } else {
        this.logger.error(
          { requestId: problem.requestId, path: request.url, err: exception },
          'unhandled error',
        );
      }
    }
    response.status(problem.status).type(PROBLEM_MEDIA_TYPE).send(problem);
  }

  toProblem(exception: unknown, request: Request & { id?: unknown }): ProblemDetails {
    const base = {
      instance: request.originalUrl || request.url,
      ...(typeof request.id === 'string' ? { requestId: request.id } : {}),
    };

    if (exception instanceof ValidationProblem) {
      return {
        ...base,
        type: problemType(PROBLEM_CODES.validationFailed),
        title: 'Request validation failed',
        status: HttpStatus.BAD_REQUEST,
        code: PROBLEM_CODES.validationFailed,
        errors: exception.fieldErrors,
      };
    }

    if (isDomainError(exception)) {
      const status = KIND_STATUS[exception.kind];
      return {
        ...base,
        type: problemType(exception.code),
        title: statusTitle(status),
        status,
        detail: exception.message,
        code: exception.code,
        ...(exception.details ? { details: exception.details } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === 404 ? PROBLEM_CODES.notFound : statusCode(status);
      return {
        ...base,
        type: problemType(code),
        title: statusTitle(status),
        status,
        detail: httpDetail(exception),
        code,
      };
    }

    return {
      ...base,
      type: problemType(PROBLEM_CODES.internalError),
      title: statusTitle(HttpStatus.INTERNAL_SERVER_ERROR),
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'An unexpected error occurred.',
      code: PROBLEM_CODES.internalError,
    };
  }
}

function httpDetail(exception: HttpException): string {
  const body: unknown = exception.getResponse();
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object' && 'message' in body) {
    const message: unknown = body.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }
  return exception.message;
}
