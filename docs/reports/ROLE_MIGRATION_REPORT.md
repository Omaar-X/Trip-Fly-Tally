# Role Migration Report — CEO / Admin / Accountant / Sales / HR

**Date:** 2026-07-30
**Status:** Applied and verified. Supersedes `ROLE_MIGRATION.md` (the pre-approval proposal) with what was actually built.

## Root cause / motivation

The system had 4 roles (`ADMIN`, `ACCOUNTANT`, `SALES`, `MANAGER`), each hardcoded independently across ~14 backend route files and ~13 frontend files, with `ADMIN` acting as an unconditional superuser bypass. You asked for a real 5-role taxonomy (`CEO`, `ADMIN`, `ACCOUNTANT`, `SALES`, `HR`) with a genuine approval hierarchy — Admin can operate but not give final sign-off, only the CEO can — fully centralized so no role name is ever hardcoded again.

## Central RBAC configuration

- **`backend/src/constants/roles.ts`** (new) — `ROLES`, `RoleName` type, `ROLE_LABELS`. `backend/src/middleware/rbac.ts`'s `allow()` imports `RoleName` from here instead of declaring its own union, and its bypass check changed from `role === 'ADMIN'` to `role === 'CEO'` — this is the one structural code-behavior change everything else follows from. `auth.controller.ts`'s registration validator derives its zod enum from `ROLES`.
- **`frontend/src/lib/roles.ts`** (new) — mirrors the backend: `ROLES`, `RoleName`, `ROLE_LABELS`, `ROLE_TONE` (badge colors), `ROLE_DESCRIPTIONS`, and `hasAnyRole(userRole, allowed[])` — the one function every page now calls instead of hand-rolled `.includes()`/`===` checks. CEO bypasses inside this helper too, so no page ever needs to list `'CEO'` explicitly.

## Full permission matrix (as applied)

| Route | Allowed roles | Notes |
|---|---|---|
| `POST /api/auth/register` | CEO only (bypass) | User Management is CEO's. |
| `GET /api/auth/users` | CEO, ADMIN | Admin can review the user list even though only CEO can create. |
| `PUT/POST /api/company-settings/*` | CEO only | Company Settings, explicitly CEO's. |
| `GET/POST /api/admin/database/*` | CEO only | Was ADMIN-only; moved per "Admin cannot access database/admin tools." |
| `POST/PATCH /api/hr/employees*`, `GET/POST /api/hr/attendance` | HR, ADMIN | HR's core scope ("Employee management only"), Admin keeps oversight. |
| `GET/POST /api/hr/payroll*`, `POST /api/hr/payroll/:id/pay` | ADMIN only | Not part of HR's stated scope (no payroll mentioned) and not Accountant's ("cannot access HR") — owned by Admin. |
| `POST /api/hr/payroll/:id/approve` | **CEO only** | The literal implementation of "final approval authority" — see workflow section below. |
| `GET /api/reports/trial-balance`, `/profit-loss`, `/balance-sheet` | ACCOUNTANT only | "Accounting reports" per your report-category breakdown. |
| `GET /api/reports/cash-book`, `/bank-book`, `/day-book` | ACCOUNTANT, ADMIN | "Operational reports" reach for Admin. |
| `GET /api/reports/daily-sales`, `/customer-outstanding` | SALES, ACCOUNTANT, ADMIN | "Sales reports." |
| *(HR gets no `/api/reports/*` access at all)* | — | Their "employee reports" are served directly by `/api/hr/employees` and `/api/hr/attendance`, which they already have. |
| `GET/POST /api/ledgers`, `POST /api/vouchers` | ACCOUNTANT only | "Accounting only," exclusive — Admin gets read access (statement/list) but not creation. |
| `GET /api/ledgers/:id/statement`, `GET/GET-one /api/vouchers` | ACCOUNTANT, ADMIN | Read/review access for Admin, matching "Review" in their scope. |
| `POST/confirm/cancel /api/bookings*` | SALES, ADMIN (+ACCOUNTANT on confirm/cancel, which post accounting entries) | Bookings are Sales' domain. |
| `POST /api/crm/customers` | SALES, ACCOUNTANT, ADMIN | |
| `POST /api/crm/suppliers` | ACCOUNTANT, ADMIN | Vendors aren't in Sales' stated list. |
| `GET/POST /api/payments` | ACCOUNTANT, ADMIN, SALES | Sales' "Collection." **Sales is additionally restricted to `direction: IN` only in the controller** — attempting an `OUT` (supplier) payment as Sales returns 403 with a clear message. |
| `POST /api/invoices` (manual) | ACCOUNTANT, SALES, ADMIN | |
| `POST /api/inventory/items`, `/movements` | ACCOUNTANT, ADMIN (+SALES on movements) | |

Full route-by-route detail with reasoning for each judgment call is in `ROLE_MIGRATION.md` (the pre-approval plan) — this table reflects what actually shipped, including your explicit corrections.

## The approval workflow (Draft → Admin Review → CEO Approval → Posted)

Applied everywhere the existing data model already has an equivalent multi-stage status — which is **payroll** (`payroll_runs.status`: `DRAFT → APPROVED → PAID`):

- **Draft**: `POST /api/hr/payroll/generate` — Admin.
- **Admin Review**: Admin already has list/detail read access to DRAFT runs before anyone approves — no new status was needed, this falls out of Admin's existing view access.
- **CEO Approval**: `POST /api/hr/payroll/:id/approve` — **CEO only**, posts the accrual voucher (Dr Salary Expense / Cr Salaries Payable). This is "Posted."
- **Paid**: `POST /api/hr/payroll/:id/pay` — Admin (disbursement), separate from "Posted."

**I deliberately did not extend this workflow to vouchers, bookings, or invoices.** None of those tables have an existing draft/review/approval status — vouchers in particular are created atomically final today, with no `status` column at all. Adding one would be a database schema change and a new state machine, which is new business-feature development, explicitly out of scope per your instruction not to build new features. If you want the same Draft→Review→Approval chain on vouchers or bookings, that needs to be its own scoped request with an explicit schema-change approval.

## HR's stated "future features"

Per your instruction, Appointment Letter / Offer Letter / Experience Letter / Employee Documents were **not built**. I checked whether the existing navigation needs a placeholder entry for them and concluded it doesn't — the HR nav item already points to a working `/hr` page (Employee Management + Attendance tabs), so there's no dead link or missing menu entry that would need a "coming soon" placeholder. Nothing was added for these.

## Files changed

**Backend (16 files):** `constants/roles.ts` (new), `middleware/rbac.ts`, `utils/jwt.ts` (comment only), `modules/auth/{auth.controller.ts,auth.routes.ts}`, `modules/adminDatabase/adminDatabase.routes.ts`, `modules/accounting/accounting.routes.ts`, `modules/bookings/bookings.routes.ts`, `modules/companySettings/companySettings.routes.ts`, `modules/hr/hr.routes.ts`, `modules/reports/reports.routes.ts` (converted from one blanket gate to per-report roles), `modules/inventory/inventory.routes.ts`, `modules/crm/crm.routes.ts`, `modules/payments/{payments.routes.ts,payments.controller.ts}` (added the Sales direction=IN check), `modules/invoices/invoices.routes.ts`.

**Frontend (14 files):** `lib/roles.ts` (new), `pages/Settings.tsx`, `pages/crm/Crm.tsx`, `pages/payments/Payments.tsx` (+ direction-restricted UI for Sales), `pages/bookings/Bookings.tsx`, `pages/inventory/Inventory.tsx`, `pages/invoices/Invoices.tsx`, `pages/hr/Hr.tsx` (payroll-tab visibility split into view/approve/pay), `components/layout/AppShell.tsx` (nav items now role-gated per the matrix above, filter uses `hasAnyRole`), `pages/CompanySetupWizard.tsx`, `pages/admin/DatabaseAdmin.tsx`, `pages/accounting/Accounting.tsx`, `pages/Login.tsx` (new bootstrap demo accounts), `pages/reports/Reports.tsx` (tabs filtered per role, empty-state for HR).

**Database:** `database/seed.sql` — 5 roles instead of 4 (see `DATA_CLEANUP_REPORT.md` for full seed rewrite detail).

## Verification

- `MANAGER` grep across `backend/src` and `frontend/src`: **zero matches** after migration.
- `tsc --noEmit` (backend) and `tsc -b && vite build` (frontend): clean.
- Live regression, 22 permission checks across all 5 roles (login, CRUD, and cross-role 403s) — see `DATA_CLEANUP_REPORT.md`'s test log for the full list — **22/22 passed**.
- Full payroll workflow exercised end-to-end: HR creates employee → Admin generates draft run → HR/Admin blocked from approving (403) → **CEO approves** (200, posts voucher) → Admin pays (200, posts disbursement voucher).
- Browser check: CEO's sidebar shows every nav item; HR's sidebar shows only Dashboard, HR & Payroll, and Settings — confirming `hasAnyRole`-based nav filtering works, not just the API gate.
