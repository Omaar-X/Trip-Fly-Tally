/**
 * Single source of truth for role names across the frontend. Mirrors
 * backend/src/constants/roles.ts. Every page/component that needs to gate
 * UI by role must import from here — no local hardcoded role arrays.
 *
 * CEO is the sole superuser: hasAnyRole() always returns true for CEO,
 * so callers never need to list 'CEO' explicitly.
 */
export const ROLES = ['CEO', 'ADMIN', 'ACCOUNTANT', 'SALES', 'HR'] as const;
export type RoleName = typeof ROLES[number];

/**
 * Named accessors (`ROLE.ADMIN`, not `'ADMIN'`) derived from `ROLES` above —
 * use these instead of role-name string literals anywhere a specific role
 * needs to be referenced (e.g. `hasAnyRole(role, [ROLE.ADMIN])`).
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

export const ROLE_TONE: Record<RoleName, string> = {
  CEO: 'violet',
  ADMIN: 'teal',
  ACCOUNTANT: 'blue',
  SALES: 'amber',
  HR: 'green',
};

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  CEO: 'Full system access — final approval authority, company settings, user management, audit, database tools, all reports.',
  ADMIN: 'Daily operations and review. Cannot give final approval and cannot access database/audit tools.',
  ACCOUNTANT: 'Full accounting operations — ledgers, vouchers, payroll disbursement records, accounting reports. Cannot approve final postings, no HR or system settings access.',
  SALES: 'Customers, quotations, bookings, and collections. No accounting access beyond customer-facing statements.',
  HR: 'Employee records only. No payroll approval, no accounting access, no financial reports.',
};

/** True if userRole is CEO (bypass) or is one of the allowed roles. */
export function hasAnyRole(userRole: string | undefined, allowed: RoleName[]): boolean {
  return !!userRole && (userRole === ROLE.CEO || allowed.includes(userRole as RoleName));
}
