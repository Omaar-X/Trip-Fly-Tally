import { signAccessToken } from '../../src/utils/jwt';
import { RoleName } from '../../src/constants/roles';

/** Builds a real, verifiable access token for a given role — for route-level tests. */
export function tokenFor(role: RoleName, overrides: Partial<{ sub: number; companyId: number; name: string }> = {}) {
  return signAccessToken({
    sub: overrides.sub ?? 1,
    companyId: overrides.companyId ?? 1,
    role,
    name: overrides.name ?? `Test ${role}`,
  });
}

export function authHeader(role: RoleName) {
  return { Authorization: `Bearer ${tokenFor(role)}` };
}
