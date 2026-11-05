import {
  type ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConflictError, InvalidInputError, NotFoundError } from '@shipkeep/domain';
import type { Request } from 'express';

import { PROBLEM_TYPE_BASE } from './problem-details';
import { ProblemDetailsFilter, ValidationProblem } from './problem-details.filter';

const request = { originalUrl: '/api/v1/apps', url: '/api/v1/apps', id: 'req_1' } as Request & {
  id?: unknown;
};

describe('ProblemDetailsFilter.toProblem', () => {
  const filter = new ProblemDetailsFilter();

  it('maps domain errors to their kind status and code', () => {
    expect(filter.toProblem(new NotFoundError('application', { id: 'a' }), request)).toEqual({
      type: `${PROBLEM_TYPE_BASE}application_not_found`,
      title: 'Not Found',
      status: 404,
      detail: 'application not found',
      code: 'application_not_found',
      details: { id: 'a' },
      instance: '/api/v1/apps',
      requestId: 'req_1',
    });
    expect(filter.toProblem(new ConflictError('slug_taken', 'slug in use'), request).status).toBe(
      409,
    );
    expect(filter.toProblem(new InvalidInputError('bad', 'bad value'), request).status).toBe(400);
  });

  it('maps validation problems with field errors', () => {
    const problem = filter.toProblem(
      new ValidationProblem([{ path: '/name', message: 'name must be lowercase' }]),
      request,
    );
    expect(problem.status).toBe(400);
    expect(problem.code).toBe('validation_failed');
    expect(problem.errors).toEqual([{ path: '/name', message: 'name must be lowercase' }]);
  });

  it('keeps the status of HTTP exceptions', () => {
    expect(filter.toProblem(new NotFoundException('Cannot GET /x'), request)).toMatchObject({
      status: 404,
      code: 'not_found',
      detail: 'Not Found',
    });
    expect(filter.toProblem(new ForbiddenException(), request)).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(filter.toProblem(new BadRequestException(['a', 'b']), request).detail).toBe(
      'Bad Request',
    );
  });

  it('hides internal errors behind an opaque 500', () => {
    const problem = filter.toProblem(
      new Error('connect ECONNREFUSED postgresql://user:hunter2@db'),
      request,
    );
    expect(problem.status).toBe(500);
    expect(problem.code).toBe('internal_error');
    expect(JSON.stringify(problem)).not.toContain('hunter2');
    expect(JSON.stringify(problem)).not.toContain('ECONNREFUSED');
  });

  it('omits the request id when the request has none', () => {
    const problem = filter.toProblem(new NotFoundException(), { url: '/x' } as Request);
    expect(problem.requestId).toBeUndefined();
    expect(problem.instance).toBe('/x');
  });

  it('does not echo query credentials, parser input or raw exceptions into responses and logs', () => {
    const secret = 'test-private-password';
    const input = {
      ...request,
      originalUrl: `/api/v1/auth/login?token=${secret}`,
      url: `/api/v1/auth/login?token=${secret}`,
    } as Request;
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const send = vi.fn();
    const response = { status: () => response, type: () => response, send };
    const host = {
      switchToHttp: () => ({ getRequest: () => input, getResponse: () => response }),
    } as unknown as ArgumentsHost;
    try {
      filter.catch(new Error(`database failed ${secret}`), host);
      filter.catch(new HttpException(`parser input ${secret}`, 503), host);
      const problem = filter.toProblem(new BadRequestException(`invalid JSON ${secret}`), input);
      expect(problem.instance).toBe('/api/v1/auth/login');
      expect(
        JSON.stringify([problem, send.mock.calls, error.mock.calls, warn.mock.calls]),
      ).not.toContain(secret);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});
