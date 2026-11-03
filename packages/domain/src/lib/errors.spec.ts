import { ConflictError, InvalidInputError, isDomainError, NotFoundError } from './errors.js';

describe('domain errors', () => {
  it('carry a kind, a code and a message', () => {
    const error = new InvalidInputError('name_invalid', 'name must be lowercase', {
      field: 'name',
    });
    expect(error.kind).toBe('invalid');
    expect(error.code).toBe('name_invalid');
    expect(error.message).toBe('name must be lowercase');
    expect(error.details).toEqual({ field: 'name' });
    expect(error.name).toBe('InvalidInputError');
    expect(error).toBeInstanceOf(Error);
  });

  it('derive not-found codes from the resource name', () => {
    const error = new NotFoundError('application', { id: 'app_1' });
    expect(error.kind).toBe('not_found');
    expect(error.code).toBe('application_not_found');
    expect(error.message).toBe('application not found');
  });

  it('are recognised by the type guard', () => {
    expect(isDomainError(new ConflictError('slug_taken', 'slug already in use'))).toBe(true);
    expect(isDomainError(new Error('plain'))).toBe(false);
    expect(isDomainError(null)).toBe(false);
  });
});
