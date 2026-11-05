import { environmentSettings, organizationSettings, projectSettings } from './tenant-settings.js';

describe('tenant resource settings', () => {
  it('normalizes display names and preserves canonical slugs', () => {
    expect(organizationSettings({ name: '  Example team  ', slug: 'example-team' })).toEqual({
      name: 'Example team',
      slug: 'example-team',
    });
    expect(projectSettings({ name: '😀'.repeat(80), slug: 'a'.repeat(40) }).name).toBe(
      '😀'.repeat(80),
    );
  });

  it('uses safe defaults and accepts only explicit supported alternatives', () => {
    expect(projectSettings({ name: 'Product', slug: 'product' })).toEqual({
      name: 'Product',
      slug: 'product',
      gitWriteMode: 'pull_request',
    });
    expect(
      projectSettings({ name: 'Product', slug: 'product', gitWriteMode: 'commit' }).gitWriteMode,
    ).toBe('commit');
    expect(environmentSettings({ name: 'production' })).toEqual({
      name: 'production',
      kind: 'standard',
      failoverPolicy: 'none',
      protected: true,
    });
    expect(
      environmentSettings({
        name: 'preview-1',
        kind: 'preview',
        failoverPolicy: 'restore-from-backup',
        protected: false,
      }),
    ).toEqual({
      name: 'preview-1',
      kind: 'preview',
      failoverPolicy: 'restore-from-backup',
      protected: false,
    });
  });

  it.each([
    null,
    4,
    '',
    '   ',
    'a'.repeat(81),
    '😀'.repeat(81),
    'bad\nname',
    'hidden\u200bname',
    'bad\ud800name',
  ])('rejects invalid display name %j', (name) => {
    expect(() => organizationSettings({ name, slug: 'valid' })).toThrow(
      expect.objectContaining({ code: 'invalid_resource_name' }),
    );
  });

  it.each([
    null,
    5,
    '',
    'a'.repeat(41),
    'UPPER',
    '1first',
    'two words',
    '../escape',
    'name\n',
    'naïve',
  ])('rejects invalid slug or environment name %j', (slug) => {
    expect(() => organizationSettings({ name: 'Valid', slug })).toThrow(
      expect.objectContaining({ code: 'invalid_resource_slug' }),
    );
    expect(() => environmentSettings({ name: slug })).toThrow(
      expect.objectContaining({ code: 'invalid_resource_slug' }),
    );
  });

  it('rejects invalid configuration values without coercing them', () => {
    for (const gitWriteMode of [null, '', true, 'force-push'])
      expect(() => projectSettings({ name: 'Valid', slug: 'valid', gitWriteMode })).toThrow(
        expect.objectContaining({ code: 'invalid_git_write_mode' }),
      );
    for (const kind of [null, false, 'system'])
      expect(() => environmentSettings({ name: 'valid', kind })).toThrow(
        expect.objectContaining({ code: 'invalid_environment_kind' }),
      );
    for (const failoverPolicy of [null, true, 'automatic'])
      expect(() => environmentSettings({ name: 'valid', failoverPolicy })).toThrow(
        expect.objectContaining({ code: 'invalid_failover_policy' }),
      );
    for (const protectedValue of [null, 'false', 0])
      expect(() => environmentSettings({ name: 'valid', protected: protectedValue })).toThrow(
        expect.objectContaining({ code: 'invalid_environment_protection' }),
      );
  });

  it('copies only configuration fields and freezes normalized values', () => {
    const input = { name: 'Product', slug: 'product', organizationId: 'foreign', role: 'owner' };
    const result = projectSettings(input);
    input.name = 'Changed';
    expect(result).toEqual({ name: 'Product', slug: 'product', gitWriteMode: 'pull_request' });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(organizationSettings(input))).toBe(true);
    expect(Object.isFrozen(environmentSettings({ name: 'production' }))).toBe(true);
  });

  it('rejects oversized display-name input before expanding Unicode code points', () => {
    expect(() => organizationSettings({ name: 'a'.repeat(10000), slug: 'valid' })).toThrow(
      expect.objectContaining({ code: 'invalid_resource_name' }),
    );
  });
});
