import { ValidationPipe, type ValidationError } from '@nestjs/common';

import { type FieldError } from './problem-details';
import { ValidationProblem } from './problem-details.filter';

/**
 * Edge validation for DTOs (CLAUDE.md, TypeScript conventions): unknown properties are rejected,
 * payloads are transformed to their DTO class, and failures become RFC 9457 problems with one
 * entry per field.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    stopAtFirstError: false,
    exceptionFactory: (errors) => new ValidationProblem(flatten(errors)),
  });
}

export function flatten(errors: readonly ValidationError[], prefix = ''): FieldError[] {
  const out: FieldError[] = [];
  for (const error of errors) {
    const path = `${prefix}/${error.property}`;
    for (const message of Object.values(error.constraints ?? {})) {
      out.push({ path, message });
    }
    if (error.children?.length) {
      out.push(...flatten(error.children, path));
    }
  }
  return out;
}
