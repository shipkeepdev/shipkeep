import { PassThrough, Writable } from 'node:stream';

import type { INestApplicationContext } from '@nestjs/common';
import { ConflictError, NotFoundError, Secret, SYSTEM_ACTOR } from '@shipkeep/domain';

import { IssueJoinToken } from './modules/fleet/application/issue-join-token';
import { CERTIFICATE_AUTHORITY } from './modules/fleet/application/ports';
import { OperatorAccountCommands } from './modules/identity/application/operator-account-commands';
import { OperatorOrganizationCommands } from './modules/organizations/application/operator-organization-commands';
import {
  needsPassword,
  operatorExitCode,
  OperatorUsageError,
  parseOperatorCommand,
  runOperatorCommand,
  USAGE,
} from './operator';

const ORG = '0190f5a8-7b1c-7e2d-8f3a-000000000001';
const TOKEN = 'sk_test_fake_join_token_value_0123456789abc';

function refusal(argv: readonly string[]): unknown {
  try {
    return parseOperatorCommand(argv);
  } catch (error: unknown) {
    return error;
  }
}

describe('operator commands of the single-machine installer (ADR 0021)', () => {
  it('reads them, and only them read no password', () => {
    const organization = parseOperatorCommand([
      'organization',
      'create',
      '--name',
      'Atelier Nord',
      '--slug',
      'atelier-nord',
      '--owner',
      'owner@example.com',
    ]);
    expect(organization).toEqual({
      action: 'organization-create',
      name: 'Atelier Nord',
      slug: 'atelier-nord',
      owner: 'owner@example.com',
    });
    // The installer may choose the id, so that a resumed run finds the organization again.
    expect(
      parseOperatorCommand([
        'organization',
        'create',
        '--name',
        'Atelier Nord',
        '--slug',
        'atelier-nord',
        '--owner',
        'owner@example.com',
        '--id',
        ORG,
      ]),
    ).toEqual({
      action: 'organization-create',
      name: 'Atelier Nord',
      slug: 'atelier-nord',
      owner: 'owner@example.com',
      id: ORG,
    });
    const token = parseOperatorCommand(['server', 'join-token', '--organization', ORG]);
    expect(token).toEqual({ action: 'join-token', organizationId: ORG });
    const fingerprint = parseOperatorCommand(['server', 'ca-fingerprint']);
    expect(fingerprint).toEqual({ action: 'ca-fingerprint' });
    for (const command of [organization, token, fingerprint])
      expect(needsPassword(command)).toBe(false);
    expect(needsPassword({ action: 'create', email: 'a@example.com' })).toBe(true);
  });

  it('refuses anything malformed, without repeating it', () => {
    const hostile = 'x; rm -rf / $(id) `id`';
    for (const argv of [
      ['organization', 'create'],
      ['organization', 'create', '--name', 'A', '--slug', 'a'],
      ['organization', 'create', '--slug', 'a', '--name', 'A', '--owner', 'o@example.com'],
      ['organization', 'create', '--name', 'A\n--admin', '--slug', 'a', '--owner', 'o@example.com'],
      [
        'organization',
        'create',
        '--name',
        'x'.repeat(200),
        '--slug',
        'a',
        '--owner',
        'o@example.com',
      ],
      ['organization', 'create', '--name', 'A', '--slug', 'a', '--owner', 'o@example.com', 'extra'],
      ['organization', 'create', '--name', 'A', '--slug', 'a', '--owner', 'o@example.com', '--id'],
      [
        'organization',
        'create',
        '--name',
        'A',
        '--slug',
        'a',
        '--owner',
        'o@example.com',
        '--id',
        'not-a-uuid',
      ],
      [
        'organization',
        'create',
        '--name',
        'A',
        '--slug',
        'a',
        '--owner',
        'o@example.com',
        '--id',
        ORG.toUpperCase(),
      ],
      [
        'organization',
        'create',
        '--name',
        'A',
        '--slug',
        'a',
        '--owner',
        'o@example.com',
        '--id',
        ORG,
        hostile,
      ],
      ['organization', 'delete', '--name', 'A'],
      ['server', 'join-token'],
      ['server', 'join-token', '--organization', 'not-a-uuid'],
      ['server', 'join-token', '--organization', `${ORG} ${hostile}`],
      ['server', 'join-token', '--organization', ORG.toUpperCase()],
      ['server', 'join-token', '--organization', ORG, '--print'],
      ['server', 'ca-fingerprint', 'extra'],
      ['server', hostile],
    ]) {
      const error = refusal(argv);
      expect(error, JSON.stringify(argv)).toBeInstanceOf(OperatorUsageError);
      expect((error as Error).message).toBe(USAGE);
    }
  });
});

describe('what those commands do', () => {
  function application(services: Map<unknown, unknown>): INestApplicationContext {
    return {
      get: (token: unknown) => services.get(token),
      close: () => Promise.resolve(),
    } as unknown as INestApplicationContext;
  }
  function lines(output: PassThrough): string {
    const written: unknown = output.read();
    return Buffer.isBuffer(written) ? written.toString() : '';
  }
  const terminal = () => Object.assign(new PassThrough(), { isTTY: true });

  it('creates the organization for an active account and says its id', async () => {
    const activeAccountId = vi.fn().mockResolvedValue('user-1');
    const create = vi
      .fn()
      .mockResolvedValue({ id: ORG, name: 'Atelier Nord', slug: 'atelier-nord' });
    const output = new PassThrough();
    await runOperatorCommand(
      application(
        new Map<unknown, unknown>([
          [OperatorAccountCommands, { activeAccountId }],
          [OperatorOrganizationCommands, { create }],
        ]),
      ),
      {
        action: 'organization-create',
        name: 'Atelier Nord',
        slug: 'atelier-nord',
        owner: 'Owner@example.com',
      },
      undefined,
      output,
      new PassThrough(),
    );
    expect(activeAccountId).toHaveBeenCalledWith('Owner@example.com');
    expect(create).toHaveBeenCalledWith(
      { name: 'Atelier Nord', slug: 'atelier-nord' },
      'user-1',
      expect.any(Date),
      undefined,
    );
    expect(lines(output)).toBe(`Organization created: ${ORG}\n`);
  });

  it('writes the join token alone, to a file or a pipe, issued by the system', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ value: new Secret(TOKEN), caFingerprint: 'sha256:x' });
    const output = new PassThrough();
    const errors = new PassThrough();
    await runOperatorCommand(
      application(new Map<unknown, unknown>([[IssueJoinToken, { execute }]])),
      { action: 'join-token', organizationId: ORG },
      undefined,
      output,
      errors,
    );
    expect(execute).toHaveBeenCalledWith({ organizationId: ORG, actor: SYSTEM_ACTOR });
    expect(lines(output)).toBe(`${TOKEN}\n`);
    expect(lines(errors)).toBe('');
  });

  it('never writes a join token to a terminal, and issues none', async () => {
    const execute = vi.fn();
    const errors = new PassThrough();
    await expect(
      runOperatorCommand(
        application(new Map<unknown, unknown>([[IssueJoinToken, { execute }]])),
        { action: 'join-token', organizationId: ORG },
        undefined,
        terminal(),
        errors,
      ),
    ).rejects.toBeInstanceOf(OperatorUsageError);
    expect(execute).not.toHaveBeenCalled();
    expect(lines(errors)).toBe('');
  });

  it('never sends the join token to the other stream when its output fails', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue({ value: new Secret(TOKEN), caFingerprint: 'sha256:x' });
    const broken = new Writable({
      write(_chunk, _encoding, done) {
        done(new Error('write EPIPE'));
      },
    });
    const errors = new PassThrough();
    await expect(
      runOperatorCommand(
        application(new Map<unknown, unknown>([[IssueJoinToken, { execute }]])),
        { action: 'join-token', organizationId: ORG },
        undefined,
        broken,
        errors,
      ),
    ).rejects.toThrow('write EPIPE');
    expect(lines(errors)).not.toContain(TOKEN);
  });

  it('says the CA fingerprint the agent pins', async () => {
    const output = new PassThrough();
    await runOperatorCommand(
      application(
        new Map<unknown, unknown>([
          [
            CERTIFICATE_AUTHORITY,
            { caFingerprint: () => Promise.resolve(`sha256:${'a'.repeat(64)}`) },
          ],
        ]),
      ),
      { action: 'ca-fingerprint' },
      undefined,
      output,
      new PassThrough(),
    );
    expect(lines(output)).toBe(`sha256:${'a'.repeat(64)}\n`);
  });

  it('still needs a password for the account commands', async () => {
    await expect(
      runOperatorCommand(
        application(new Map()),
        { action: 'create', email: 'a@example.com' },
        undefined,
        new PassThrough(),
        new PassThrough(),
      ),
    ).rejects.toBeInstanceOf(OperatorUsageError);
  });
});

describe('the exit status of a refused command', () => {
  it('tells an existing account apart, so that a resumed installer keeps it', () => {
    expect(operatorExitCode(new OperatorUsageError())).toBe(2);
    expect(
      operatorExitCode(
        new ConflictError('account_exists', 'An account with this address already exists.'),
      ),
    ).toBe(3);
    expect(operatorExitCode(new ConflictError('organization_slug_unavailable', 'x'))).toBe(1);
    expect(operatorExitCode(new NotFoundError('Account'))).toBe(1);
    expect(operatorExitCode(new Error('connect ECONNREFUSED'))).toBe(1);
  });
});
