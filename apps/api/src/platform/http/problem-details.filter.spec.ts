import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
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
      detail: 'Cannot GET /x',
    });
    expect(filter.toProblem(new ForbiddenException(), request)).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(filter.toProblem(new BadRequestException(['a', 'b']), request).detail).toBe('a; b');
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
});
