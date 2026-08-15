# Role Migration Plan — CEO / Admin / Accountant / Sales / HR

**Status: PROPOSAL ONLY. No code has been changed.** This document exists so you can approve or redirect the plan before anything is touched, per your instruction.

## What triggers this

Current system: 4 roles (`ADMIN`, `ACCOUNTANT`, `SALES`, `MANAGER`), each hardcoded independently in ~14 backend route files and ~13 frontend files (full inventory below). You've asked for a real taxonomy change: 5 roles (`CEO`, `ADMIN`, `ACCOUNTANT`, `SALES`, `HR`), fully centralized, with `HR` replacing `MANAGER` and `CEO` added as a new top role with final-approval authority that `ADMIN` explicitly does not have.

## New role definitions (as you specified)

| Role | Scope |
|---|---|
| **CEO** | Full system access. Final approval authority. Company Settings. User Management. Reports. Audit Log. |
| **ADMIN** | Manage daily operations. Review submissions. **Cannot** perform final CEO approval. |
| **ACCOUNTANT** | Accounting only. |
| **SALES** | CRM, Customers, Quotations, Sales. |
| **HR** | Employee Management. Appointment Letter. Offer Letter. Experience Letter. Leave. Employee Documents. |

### Not in scope for this migration — flagging so it's a decision, not an oversight

"Appointment Letter," "Offer Letter," "Experience Letter," and "Employee Documents" **don't exist as features anywhere in this codebase today** — there's no letter-generation, document-storage, or template system of any kind. This migration will give `HR` the role and gate it correctly against everything that *does* exist (employee records, attendance/leave), but it will not build those four features — that's new feature development, which you told me to stop. If you want them built, that's a separate, later request.

"Quotations" (under Sales) also doesn't exist as a feature — the closest existing concept is a `PENDING` booking (a booking not yet confirmed into an invoice), which I'll treat as the quotation-equivalent for gating purposes.

## Centralization design

**Backend — one new file, `backend/src/constants/roles.ts`:**
```ts
export const ROLES = ['CEO', 'ADMIN', 'ACCOUNTANT', 'SALES', 'HR'] as const;
export type RoleName = typeof ROLES[number];
export const ROLE_LABELS: Record<RoleName, string> = {
  CEO: 'Chief Executive Officer', ADMIN: 'Administrator',
  ACCOUNTANT: 'Accountant', SALES: 'Sales Executive', HR: 'HR Manager'
};
```
`backend/src/middleware/rbac.ts` imports `RoleName` from here instead of declaring its own union, and `allow()`'s automatic bypass changes from `role === 'ADMIN'` to `role === 'CEO'` (see "The bypass question" below). `auth.controller.ts`'s `registerSchema` derives its zod enum from `ROLES` instead of a separately hand-typed list. Every `allow(...)` call across every route file is updated per the matrix below.

**Database:** `roles` table structure is unchanged (it's already generic: `id/name/label/description`) — only its *seeded content* changes, as part of the seed.sql rewrite you already requested. The TS `ROLES` constant and the DB `roles.name` column values must be kept in sync by hand (same soft coupling that already exists today, not a new problem).

**Frontend — one new file, `frontend/src/lib/roles.ts`:**
```ts
export const ROLES = ['CEO', 'ADMIN', 'ACCOUNTANT', 'SALES', 'HR'] as const;
export type RoleName = typeof ROLES[number];
export const ROLE_LABELS: Record<RoleName, string> = { /* same as backend */ };
export const ROLE_TONE: Record<RoleName, string> = { CEO: 'violet', ADMIN: 'teal', ACCOUNTANT: 'blue', SALES: 'amber', HR: 'green' };
export const ROLE_DESCRIPTIONS: Record<RoleName, string> = { /* for the Settings page permission matrix */ };
export function hasAnyRole(userRole: string | undefined, allowed: RoleName[]): boolean {
  return !!userRole && (userRole === 'CEO' || allowed.includes(userRole as RoleName));
}
```
Every page listed in the frontend inventory below imports `hasAnyRole` (or `ROLE_*` constants) instead of a locally hardcoded array/comparison — this is the fix for the "duplicate hardcoded role names across 9+ files" finding from the earlier code review.

## The bypass question (the one structural decision this migration makes)

Today, `allow()` treats `ADMIN` as an unconditional superuser — `if (role === 'ADMIN' || roles.includes(role)) return next()`. Under the new model, `ADMIN` explicitly **cannot** do CEO-only actions, so `ADMIN` can no longer auto-bypass everything. I'm proposing `CEO` takes over that bypass role (full system access, matches your description), and `ADMIN` becomes a normal role that must be explicitly listed on every route it should reach — same mechanism, different role holds the "always passes" seat.

## Full permission matrix (every route, old → proposed new)

Unless noted, `CEO` is omitted from the "new" column because it always passes via the bypass — only routes where CEO access matters for *reading the intent* have it written explicitly.

| Route | Old `allow(...)` | Proposed new | Reasoning |
|---|---|---|---|
| `POST /api/auth/register` | *(bypass-only, i.e. ADMIN)* | `CEO` only (bypass) | "User Management" is explicitly CEO's. |
| `GET /api/auth/users` | `MANAGER` | `ADMIN` | Viewing the user list fits "manage daily operations / review submissions" even though *creating* users is CEO-only. |
| `PUT/POST /api/company-settings/*` | `ADMIN` | `CEO` | "Company Settings" is explicitly, unambiguously CEO's. |
| `GET/POST/PUT /api/admin/database/*` | `ADMIN` | `CEO` | Closest existing feature to "Audit Log" — full raw data/audit access. **Judgment call — see open questions.** |
| `POST /api/hr/employees`, `PATCH /api/hr/employees/:id` | `MANAGER` | `HR`, `ADMIN` | Employee Management is HR's core scope; Admin keeps oversight. |
| `GET /api/hr/employees` | `MANAGER, ACCOUNTANT` | `HR, ADMIN, ACCOUNTANT` | Unchanged reach, HR added as primary owner. |
| `GET /api/hr/attendance`, `POST /api/hr/attendance` | `MANAGER` | `HR`, `ADMIN` | "Leave" (an attendance status) is HR's. |
| `GET /api/hr/payroll`, `GET /api/hr/payroll/:id` | `MANAGER, ACCOUNTANT` | `ADMIN, ACCOUNTANT` | HR's stated scope doesn't mention payroll at all — moved to Admin+Accountant. **Judgment call.** |
| `POST /api/hr/payroll/generate` | `MANAGER, ACCOUNTANT` | `ADMIN, ACCOUNTANT` | Same reasoning. |
| `POST /api/hr/payroll/:id/approve` | `MANAGER, ACCOUNTANT` | **`CEO` only** | The clearest match to "final approval authority" anywhere in the app. **This is my strongest recommendation in this whole doc — flagging clearly since it's a real permission tightening, not just a rename.** |
| `POST /api/hr/payroll/:id/pay` | `ACCOUNTANT` | `ACCOUNTANT` (unchanged) | Disbursement is an accounting action once approved. |
| `GET /api/hr/payslips/:id/pdf` | `MANAGER, ACCOUNTANT` | `HR, ADMIN, ACCOUNTANT` | "Employee Documents" plausibly covers payslips. |
| `GET /api/reports/*` | `ACCOUNTANT, MANAGER` | `ACCOUNTANT, ADMIN`, and `CEO` (bypass) | Reports stays reachable by Accountant (who produces the numbers) as well as CEO; Admin replaces Manager's oversight seat. **Judgment call — see open questions on whether Accountant should keep this.** |
| `POST /api/inventory/items` | `ACCOUNTANT, MANAGER` | `ACCOUNTANT, ADMIN` | |
| `POST /api/inventory/movements` | `ACCOUNTANT, SALES` | `ACCOUNTANT, SALES` (unchanged) | |
| `POST /api/crm/customers` | `SALES, ACCOUNTANT` | `SALES, ACCOUNTANT` (unchanged) | Customers are core Sales scope. |
| `POST /api/crm/suppliers` | `ACCOUNTANT, MANAGER` | `ACCOUNTANT, ADMIN` | Suppliers aren't in Sales' stated list ("CRM, Customers, Quotations, Sales" — no vendors), so left with Accountant+Admin. |
| `POST /api/payments` | `ACCOUNTANT, MANAGER` | `ACCOUNTANT, ADMIN` | |
| `GET /api/payments` | `ACCOUNTANT, MANAGER, SALES` | `ACCOUNTANT, ADMIN, SALES` | |
| `POST /api/invoices` (manual) | `ACCOUNTANT, SALES, MANAGER` | `ACCOUNTANT, SALES, ADMIN` | |
| `POST /api/bookings`, `/:id/confirm`, `/:id/cancel` | `SALES, MANAGER` / `SALES, ACCOUNTANT, MANAGER` (×2) | `SALES, ADMIN` / `SALES, ACCOUNTANT, ADMIN` (×2) | Bookings are Sales' domain; Admin keeps oversight; booking *confirm* posts real accounting entries so Accountant stays on the confirm/cancel actions. |
| `GET/POST /api/ledgers`, `/api/vouchers` | `ACCOUNTANT` / `ACCOUNTANT, MANAGER` | `ACCOUNTANT` / `ACCOUNTANT, ADMIN` | "Accounting only" for Accountant; Admin keeps read oversight. |

## Open questions — please confirm or redirect before I apply anything

1. **Payroll approval → CEO-only.** This is a real permission *tightening*, not a rename: today `MANAGER` or `ACCOUNTANT` can approve payroll; under this plan only `CEO` can. Confirm this is intended (it's the most literal reading of "final approval authority," but it does mean a company with no CEO logged in can't run payroll).
2. **`adminDatabase` (table browser / CSV export / backup) → CEO-only**, replacing today's `ADMIN`-only gate. This is the module I just spent two commits hardening for tenant isolation — moving it to CEO-only is straightforward (`allow('CEO')`... but see point 5, it may not even need an explicit `allow()` once CEO bypasses everything) but worth your explicit sign-off since it's your most sensitive tool.
3. **Reports access for Accountant.** "Reports" is explicitly listed under CEO. I'm proposing Accountant *keeps* report access too (they're the ones producing the financial numbers reports are built from) rather than becoming CEO-exclusive — confirm that reading is right, not that CEO is the *only* one who should see reports.
4. **HR and payroll: zero visibility, or read-only?** HR's stated scope never mentions payroll. I'm proposing HR gets **no payroll access at all** (not even viewing). If HR should at least see payslips for the employees they manage, tell me and I'll add `GET /api/hr/payroll*` (read-only) to HR's grant.
5. **Does `CEO` need to be explicitly listed anywhere, or is the bypass sufficient everywhere?** Since `CEO` bypasses every `allow()` check under this design, no route ever needs to list `CEO` explicitly for CEO to reach it. I've still written it into the table above wherever the *intent* is CEO-specific, purely for documentation clarity — confirm that's fine, or tell me if you'd rather routes list `CEO` explicitly (no bypass at all, fully explicit everywhere, slightly more verbose but leaves nothing implicit).

## Full file inventory (every place a role name is hardcoded today)

**Backend (14 files):**
`middleware/rbac.ts`, `modules/auth/{auth.controller.ts,auth.routes.ts}`, `modules/adminDatabase/adminDatabase.routes.ts`, `modules/accounting/accounting.routes.ts`, `modules/bookings/bookings.routes.ts`, `modules/companySettings/companySettings.routes.ts`, `modules/hr/hr.routes.ts`, `modules/reports/reports.routes.ts`, `modules/inventory/inventory.routes.ts`, `modules/crm/crm.routes.ts`, `modules/payments/payments.routes.ts`, `modules/invoices/invoices.routes.ts`, plus the new `constants/roles.ts`.

**Frontend (13 files):**
`pages/Settings.tsx` (ROLE_TONE, ROLE_MATRIX, canSeeUsers, role `<select>`, default form role), `pages/crm/Crm.tsx`, `pages/payments/Payments.tsx`, `pages/bookings/Bookings.tsx`, `pages/inventory/Inventory.tsx`, `pages/invoices/Invoices.tsx`, `pages/hr/Hr.tsx` (isManager/canPayroll/canPay — semantics change, not just renames, per the payroll-scope decision above), `components/layout/AppShell.tsx` (Database nav item's `roles: ['ADMIN']`), `pages/CompanySetupWizard.tsx` (`isAdmin` check — becomes a CEO check since Company Settings is CEO's), `pages/admin/DatabaseAdmin.tsx` (same), `pages/accounting/Accounting.tsx`, `pages/Login.tsx` (demo account list — converges with the seed.sql rewrite from the data-cleanup request), plus the new `lib/roles.ts`.

**Database:** `database/seed.sql`'s `roles` and `users` inserts — this is the same file the pending "Production Data Cleanup" work needs to rewrite anyway, so I'd do both in the same pass once this plan is approved, rather than rewriting seed.sql twice.

## What happens after approval

Once you confirm the matrix (and answer the 5 open questions, or tell me to use my proposed defaults), I'll apply the migration across every file above in one pass, then continue directly into the Production Data Cleanup work (delete all demo/sample data, rewrite `seed.sql` to seed exactly 5 users — one per new role — and nothing else), run typecheck + build, regression-test login/permissions for all 5 roles, and produce both `DATA_CLEANUP_REPORT.md` and a completed version of this migration doc reflecting what was actually applied.
