/**
 * Single source of truth for role names across the backend. Every RBAC
 * check (middleware/rbac.ts), the user-registration validator, and
 * database/seed.sql's `roles` table content must agree with this list.
 *
 * CEO is the sole superuser (see middleware/rbac.ts's `allow()`) — it is
 * never listed explicitly on a route because it always passes.
 */
export const ROLES = ['CEO', 'ADMIN', 'ACCOUNTANT', 'SALES', 'HR'] as const;
export type RoleName = typeof ROLES[number];

/**
 * Named accessors (`ROLE.ADMIN`, not `'ADMIN'`) derived from `ROLES` above —
 * use these instead of role-name string literals anywhere a specific role
 * needs to be referenced (e.g. `allow(ROLE.ADMIN)`).
 */
export const ROLE: { [K in RoleName]: K } = Object.fromEntries(
  ROLES.map((r) => [r, r])
) as { [K in RoleName]: K };

export const ROLE_LABELS: Record<RoleName, string> = {
  CEO: 'Chief Executive Officer',
  ADMIN: 'Administrator',
  ACCOUNTANT: 'Accountant',
  SALES: 'Sales Executive',
  HR: 'HR Manager',
};
