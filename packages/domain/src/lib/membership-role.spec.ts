import { parseOrganizationRole, parseResourceRole } from './membership-role.js';

describe('membership role inputs', () => {
  it('accepts only canonical organization and resource roles', () => {
    for (const role of ['owner', 'admin', 'member']) expect(parseOrganizationRole(role)).toBe(role);
    for (const role of ['admin', 'developer', 'viewer']) expect(parseResourceRole(role)).toBe(role);
  });
  it.each([null, undefined, '', 'OWNER', 'owner\n', 'admin ', '*', {}, 1])(
    'rejects noncanonical values %j',
    (value) => {
      expect(() => parseOrganizationRole(value)).toThrow('Choose owner, admin or member.');
      expect(() => parseResourceRole(value)).toThrow('Choose admin, developer or viewer.');
    },
  );
  it('keeps organization and resource privileges separate', () => {
    expect(() => parseResourceRole('owner')).toThrow();
    expect(() => parseOrganizationRole('developer')).toThrow();
  });
});
