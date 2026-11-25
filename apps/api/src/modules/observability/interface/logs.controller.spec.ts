import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { logsPeriod } from './logs.controller';
import { LogsQueryDto } from './logs.dto';

const now = new Date('2026-11-25T12:00:00Z');

async function invalid(query: Record<string, string>): Promise<string[]> {
  const errors = await validate(plainToInstance(LogsQueryDto, query));
  return errors.map((error) => error.property);
}

describe('the logs route', () => {
  it('searches the last hour by default', () => {
    expect(logsPeriod({}, now)).toEqual({ from: new Date('2026-11-25T11:00:00Z'), to: now });
  });

  it('refuses a period that ends before it starts, or lasts more than 30 days', () => {
    expect(() =>
      logsPeriod({ from: '2026-11-25T12:00:00Z', to: '2026-11-25T11:00:00Z' }, now),
    ).toThrow(BadRequestException);
    expect(() => logsPeriod({ from: '2026-10-25T11:59:59Z' }, now)).toThrow(BadRequestException);
    expect(logsPeriod({ from: '2026-10-26T12:00:00Z' }, now).from).toEqual(
      new Date('2026-10-26T12:00:00Z'),
    );
  });

  it('takes times with their offset only, and an order of newest or oldest', async () => {
    expect(
      await invalid({ from: '2026-11-25T11:00:00Z', to: '2026-11-25T12:00:00+01:00' }),
    ).toEqual([]);
    expect(await invalid({ from: '2026-11-25T11:00:00.123456789Z', order: 'oldest' })).toEqual([]);
    expect(await invalid({ from: '2026-11-25T11:00:00' })).toEqual(['from']);
    expect(await invalid({ to: '2026-11-25T11:00:00' })).toEqual(['to']);
    expect(await invalid({ order: 'random' })).toEqual(['order']);
  });
});
