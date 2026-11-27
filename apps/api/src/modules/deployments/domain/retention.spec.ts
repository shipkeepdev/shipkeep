import { describe, expect, it } from 'vitest';

import { keptTags, type RetainedRelease } from './retention';

const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 12, minute));
const succeeded = (minute: number) => ({ state: 'succeeded', finishedAt: at(minute) });
const failed = (minute: number) => ({ state: 'failed', finishedAt: at(minute) });
const release = (
  number: number,
  ...deployments: RetainedRelease['deployments'][number][]
): RetainedRelease => ({ number, deployments });

describe('image retention (ADR 0030)', () => {
  it('keeps the six releases last deployed with success', () => {
    const releases = Array.from({ length: 9 }, (_, index) => release(index + 1, succeeded(index)));
    expect([...keptTags(releases)].sort()).toEqual(['4', '5', '6', '7', '8', '9']);
  });

  it('keeps the release a rollback serves, though older than the others', () => {
    // Releases 1 to 8 deployed in turn, then release 2 again, last: it serves.
    const releases = Array.from({ length: 8 }, (_, index) =>
      index + 1 === 2
        ? release(2, succeeded(index), succeeded(30))
        : release(index + 1, succeeded(index)),
    );
    expect([...keptTags(releases)].sort()).toEqual(['2', '4', '5', '6', '7', '8']);
  });

  it('keeps what a deployment still runs for, and nothing for failed builds', () => {
    const kept = keptTags([
      release(1, succeeded(1)),
      release(2, failed(2)),
      release(3, { state: 'building', finishedAt: null }),
      release(4, { state: 'cancelled', finishedAt: at(4) }),
    ]);
    expect([...kept].sort()).toEqual(['1', '3']);
  });

  it('keeps nothing for an application without a successful or running deployment', () => {
    expect(keptTags([release(1, failed(1))]).size).toBe(0);
    expect(keptTags([]).size).toBe(0);
  });
});
