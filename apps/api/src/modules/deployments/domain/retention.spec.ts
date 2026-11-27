import { describe, expect, it } from 'vitest';

import { keptTags, type RetainedRelease } from './retention';

const REPOSITORY = '0190f5a8-7b1c-7e2d-8f3a-0000000000aa/0190f5a8-7b1c-7e2d-8f3a-0000000000ab';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 12, minute));
const succeeded = (minute: number) => ({ state: 'succeeded', finishedAt: at(minute) });
const failed = (minute: number) => ({ state: 'failed', finishedAt: at(minute) });
/** A release built into the installation's registry: its image is its own number's tag. */
const release = (
  number: number,
  ...deployments: RetainedRelease['deployments'][number][]
): RetainedRelease => ({
  number,
  image: `cp.example.com/${REPOSITORY}:${String(number)}`,
  deployments,
});
const kept = (releases: readonly RetainedRelease[]) => [...keptTags(releases, REPOSITORY)].sort();

describe('image retention (ADR 0030)', () => {
  it('keeps the six releases last deployed with success', () => {
    const releases = Array.from({ length: 9 }, (_, index) => release(index + 1, succeeded(index)));
    expect(kept(releases)).toEqual(['4', '5', '6', '7', '8', '9']);
  });

  it('keeps the release a rollback serves, though older than the others', () => {
    // Releases 1 to 8 deployed in turn, then release 2 again, last: it serves.
    const releases = Array.from({ length: 8 }, (_, index) =>
      index + 1 === 2
        ? release(2, succeeded(index), succeeded(30))
        : release(index + 1, succeeded(index)),
    );
    expect(kept(releases)).toEqual(['2', '4', '5', '6', '7', '8']);
  });

  it("keeps the tag a rollback's copy runs, which is its source's", () => {
    // Release 9 is the copy a rollback to release 2 made: it runs release 2's image.
    const releases = [
      ...Array.from({ length: 8 }, (_, index) => release(index + 1, succeeded(index))),
      { ...release(9, succeeded(30)), image: `cp.example.com/${REPOSITORY}:2` },
    ];
    expect(kept(releases)).toEqual(['2', '4', '5', '6', '7', '8']);
  });

  it('keeps what a deployment still runs for, and nothing for failed builds', () => {
    expect(
      kept([
        release(1, succeeded(1)),
        release(2, failed(2)),
        release(3, { state: 'building', finishedAt: null }),
        release(4, { state: 'cancelled', finishedAt: at(4) }),
      ]),
    ).toEqual(['1', '3']);
  });

  it('keeps no tag for an image of another repository, or one it cannot read', () => {
    expect(
      kept([
        { ...release(1, succeeded(1)), image: 'ghcr.io/acme/billing:1' },
        { ...release(2, succeeded(2)), image: `ghcr.io/acme/billing@sha256:${'c'.repeat(64)}` },
        {
          ...release(3, succeeded(3)),
          image: `cp.example.com/${REPOSITORY}@sha256:${'c'.repeat(64)}`,
        },
        { ...release(4, succeeded(4)), image: 'not an image' },
        release(5, succeeded(5)),
      ]),
    ).toEqual(['5']);
  });

  it('keeps nothing for an application without a successful or running deployment', () => {
    expect(kept([release(1, failed(1))])).toEqual([]);
    expect(kept([])).toEqual([]);
  });
});
