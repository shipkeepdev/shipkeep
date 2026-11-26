import { NotFoundError } from '@shipkeep/domain';

import {
  presentationOutcome,
  READOPTION_REFRESH_MS,
  ReadoptionExpiredError,
  ReadoptionNotPendingError,
  type ReadoptionRequest,
  readoptable,
  worthRecording,
} from './node-readoption';

const now = new Date('2026-11-26T12:00:00Z');
const hour = 3_600_000;
const current = {
  notBefore: new Date(now.getTime() - hour),
  notAfter: new Date(now.getTime() + hour),
};
const request = (overrides: Partial<ReadoptionRequest> = {}): ReadoptionRequest => ({
  organizationId: '0192f0c0-0000-7000-8000-0000000000a1',
  nodeId: '0192f0c0-0000-7000-8000-0000000000b1',
  serial: '0a',
  ...current,
  firstSeenAt: now,
  lastSeenAt: now,
  ...overrides,
});

describe('worthRecording', () => {
  it('records a current unknown certificate of a node that is still there', () => {
    for (const status of ['enrolling', 'ready', 'suspect', 'down', 'draining'] as const)
      expect(worthRecording(false, current, { status }, now)).toBe(true);
  });

  it('leaves a known serial refused: revocation and expiry hold', () => {
    expect(worthRecording(true, current, { status: 'ready' }, now)).toBe(false);
  });

  it('records nothing for a removed node, a node of another organization or none', () => {
    expect(worthRecording(false, current, { status: 'removed' }, now)).toBe(false);
    expect(worthRecording(false, current, undefined, now)).toBe(false);
  });

  it('records nothing for a certificate that is not current', () => {
    for (const validity of [
      { notBefore: new Date(now.getTime() + 1), notAfter: current.notAfter },
      { notBefore: current.notBefore, notAfter: now },
      { notBefore: current.notBefore, notAfter: new Date(now.getTime() - 1) },
    ])
      expect(worthRecording(false, validity, { status: 'ready' }, now)).toBe(false);
  });
});

describe('presentationOutcome', () => {
  it('records a first presentation, or a certificate other than the recorded one', () => {
    expect(presentationOutcome(undefined, '0a', now)).toBe('record');
    expect(presentationOutcome(request({ serial: '0b' }), '0a', now)).toBe('record');
  });

  it('refreshes the same certificate at most once a minute', () => {
    const seen = new Date(now.getTime() - READOPTION_REFRESH_MS + 1);
    expect(presentationOutcome(request({ lastSeenAt: seen }), '0a', now)).toBe('none');
    const older = new Date(now.getTime() - READOPTION_REFRESH_MS);
    expect(presentationOutcome(request({ lastSeenAt: older }), '0a', now)).toBe('refresh');
  });
});

describe('readoptable', () => {
  it('confirms a current request for a node still there', () => {
    expect(readoptable(request(), { status: 'down' }, now)).toEqual(request());
  });

  it('refuses without a request, or for a removed node', () => {
    expect(() => readoptable(undefined, { status: 'down' }, now)).toThrow(
      ReadoptionNotPendingError,
    );
    expect(() => readoptable(request(), { status: 'removed' }, now)).toThrow(
      ReadoptionNotPendingError,
    );
    expect(() => readoptable(request(), undefined, now)).toThrow(NotFoundError);
  });

  it('refuses a certificate that expired while it waited, or is not valid yet', () => {
    expect(() => readoptable(request({ notAfter: now }), { status: 'down' }, now)).toThrow(
      ReadoptionExpiredError,
    );
    expect(() =>
      readoptable(request({ notBefore: new Date(now.getTime() + 1) }), { status: 'down' }, now),
    ).toThrow(ReadoptionExpiredError);
  });
});
