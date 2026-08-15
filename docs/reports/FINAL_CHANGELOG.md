# Changelog — RBAC Migration & Production Data Cleanup

**Date:** 2026-07-30

## Added

- `backend/src/constants/roles.ts` — single source of truth for role names/labels on the backend.
- `frontend/src/lib/roles.ts` — single source of truth for role names/labels/colors/descriptions and the `hasAnyRole()` permission helper on the frontend.
- `CEO` role — full system access, sole superuser bypass in `allow()`, final approval authority, exclusive access to Company Settings, User Management, and the Database/Audit tools.
- `HR` role — replaces `MANAGER`, scoped to employee management and attendance/leave only (no payroll, no accounting, no financial reports).
- Sales-specific restriction on `POST /api/payments`: Sales can record incoming ("Collection") payments only — outgoing/supplier payments return 403.
- Per-report RBAC on `/api/reports/*` (previously one blanket gate for the whole module): accounting reports → Accountant; operational reports → +Admin; sales reports → +Sales; HR gets none (served instead by their existing `/api/hr/*` access).
- `database/migrations/001_company_settings.sql` *(pre-existing from earlier work this session, unrelated to this migration — noted for completeness)*.

## Changed

- **`allow()`'s superuser bypass moved from `ADMIN` to `CEO`.** Admin is now a normal role that must be explicitly listed per route — this is the one structural authorization-behavior change everything else in this migration follows from.
- **Payroll approval workflow now requires the CEO explicitly** (`POST /api/hr/payroll/:id/approve`) — previously reachable by Manager or Accountant. Draft (generate) and Pay (disbursement) moved to Admin; Accountant lost payroll access entirely ("cannot access HR").
- Every `allow('MANAGER', ...)` call site across 10 backend route files updated — `MANAGER` replaced by `ADMIN` (its closest equivalent for "daily operations") or removed, per the approved permission matrix in `ROLE_MIGRATION_REPORT.md`.
- Every hardcoded role array/comparison across 13 frontend files replaced with `hasAnyRole()` calls against the central `frontend/src/lib/roles.ts`.
- Sidebar navigation (`AppShell.tsx`) is now role-gated per section (Finance/Operations hidden from HR; HR & Payroll hidden from Accountant/Sales; Database restricted to CEO) instead of only the Database item being restricted.
- Reports page tabs are filtered per the logged-in role, with an empty-state message for roles with no report access (HR).
- `database/seed.sql` rewritten from a full demo dataset to a minimal production-ready baseline: 5 roles, 5 bootstrap users, one blank placeholder company, and a zero-balance default chart of accounts. No customers, vendors, employees, invoices, bookings, payments, vouchers, or payroll are seeded.
- `README.md` updated: RBAC role list, login credentials table, setup commands (added `--default-character-set=utf8mb4` after diagnosing a real encoding bug during this work — see `DATA_CLEANUP_REPORT.md`).

## Removed

- The `MANAGER` role — fully removed from the codebase (`grep -r MANAGER backend/src frontend/src` returns zero matches).
- All demo/sample business data from `seed.sql`: customers, suppliers, warehouses, items, stock entries, employees, attendance, payroll, vouchers, voucher entries, invoices, invoice items, bookings, payments (full accounting).
- The old `*@tripflybd.com` demo login accounts, replaced by `*@example.com` bootstrap accounts.
- Three non-system example expense ledgers (`Office Rent`, `Utilities`, `Marketing & Ads`) that weren't required by the accounting engine.

## Fixed

- A character-encoding bug (unrelated to the role/data logic itself, found while testing the new seed): applying `seed.sql` via `mysql ... < file` without an explicit UTF-8 client charset silently corrupted the em-dash in a system ledger name, breaking payroll disbursement lookups. Documented and worked around in `README.md`.

## Verification performed

- `tsc --noEmit` (backend), `tsc -b && vite build` (frontend) — both clean.
- `grep -r "MANAGER"` across backend and frontend source — zero matches.
- Fresh `schema.sql` + `seed.sql` applied to the local dev database; row counts confirmed empty everywhere except roles/users/company-placeholder/chart-of-accounts.
- 22 live permission-boundary checks across all 5 roles (login, allowed actions succeed, disallowed actions 403) — all passed.
- End-to-end payroll approval workflow exercised through every stage (HR creates employee → Admin generates draft → Admin/HR blocked from approving → CEO approves → Admin pays) — confirmed working.
- Browser-verified nav visibility for CEO (sees everything) and HR (sees only Dashboard/HR & Payroll/Settings).
- Database reset to the pristine seeded baseline after all testing — no leftover test data.

## Documents produced this session (this task)

- `ROLE_MIGRATION.md` — pre-approval proposal (superseded by the report below, kept for the historical record of what was proposed vs. what you corrected).
- `ROLE_MIGRATION_REPORT.md` — what was actually implemented, full permission matrix, workflow reasoning.
- `DATA_CLEANUP_REPORT.md` — deleted/remaining records with justification for everything kept.
- `FINAL_CHANGELOG.md` — this file.

## Not done (explicitly out of scope, flagged rather than silently skipped)

- No new business features were built. HR's "future features" (Appointment/Offer/Experience Letter, Employee Documents) remain unbuilt — no placeholder pages were needed since existing navigation doesn't dead-end for HR.
- The Draft→Review→Approval workflow was **not** extended to vouchers, bookings, or invoices — none of those have an existing status column that supports it, and adding one would be a schema change / new feature, not cleanup.
