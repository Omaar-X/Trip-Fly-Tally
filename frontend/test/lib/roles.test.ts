import { describe, it, expect } from 'vitest';
import { hasAnyRole, ROLE, ROLES, RoleName } from '../../src/lib/roles';

describe('hasAnyRole()', () => {
  it('CEO always passes, even against an unrelated allow-list', () => {
    expect(hasAnyRole(ROLE.CEO, [ROLE.ACCOUNTANT])).toBe(true);
  });

  it('allows a role that is explicitly listed', () => {
    expect(hasAnyRole(ROLE.SALES, [ROLE.SALES, ROLE.ADMIN])).toBe(true);
  });

  it('rejects a role that is not listed', () => {
    expect(hasAnyRole(ROLE.HR, [ROLE.ADMIN, ROLE.ACCOUNTANT])).toBe(false);
  });

  it('rejects an undefined role', () => {
    expect(hasAnyRole(undefined, [ROLE.ADMIN])).toBe(false);
  });
});

describe('ROLE / ROLES consistency', () => {
  it('ROLE has exactly one named accessor per entry in ROLES, each mapping to itself', () => {
    for (const role of ROLES) {
      expect(ROLE[role as RoleName]).toBe(role);
    }
    expect(Object.keys(ROLE).sort()).toEqual([...ROLES].sort());
  });
});
