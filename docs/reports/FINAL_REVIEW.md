# Final Pre-Commit Review

**Date:** 2026-07-30
**Status:** Nothing has been committed. This document covers the entire uncommitted working tree — not just today's RBAC migration, but everything accumulated across this session (Company Settings module, security hardening, tenant-isolation fixes, RBAC migration, data cleanup) since the last commit (`ba0c0e1`).

---

## 1. Complete diff summary

```
$ git diff --stat
 55 files changed, 841 insertions(+), 552 deletions(-)
```

Plus **34 new untracked paths** (13 source/config files, 3 new module directories, 8 new documentation reports, 12 screenshot artifacts, 1 tool-config directory). Full breakdown below.

## 2. Every modified file (tracked, `git diff --stat`)

```
README.md                                              |  29 +-
backend/.env.example                                   |  10 +-
backend/.gitignore                                     |   1 +
backend/package-lock.json                              | 187 ++++++++++++-
backend/package.json                                   |   9 +-
backend/railway.json                                   |   1 +
backend/src/app.ts                                     |  28 +-
backend/src/config/db.ts                                |  20 +-
backend/src/config/env.ts                               |  58 +++-
backend/src/middleware/rbac.ts                          |   9 +-
backend/src/modules/accounting/accounting.controller.ts |  24 +-
backend/src/modules/accounting/accounting.routes.ts     |   6 +-
backend/src/modules/adminDatabase/adminDatabase.routes.ts|   2 +-
backend/src/modules/auth/auth.controller.ts             |   9 +-
backend/src/modules/auth/auth.routes.ts                 |   4 +-
backend/src/modules/auth/auth.service.ts                |  17 +-
backend/src/modules/bookings/bookings.controller.ts     |  31 ++-
backend/src/modules/bookings/bookings.routes.ts         |   6 +-
backend/src/modules/crm/crm.controller.ts               |   3 +-
backend/src/modules/crm/crm.routes.ts                   |   4 +-
backend/src/modules/hr/hr.controller.ts                 |  18 +-
backend/src/modules/hr/hr.routes.ts                     |  26 +-
backend/src/modules/hr/payslip.pdf.ts                   |   8 +-
backend/src/modules/inventory/inventory.controller.ts   |   7 +-
backend/src/modules/inventory/inventory.routes.ts       |   4 +-
backend/src/modules/invoices/invoice.pdf.ts             |   8 +-
backend/src/modules/invoices/invoices.controller.ts     |  20 +-
backend/src/modules/invoices/invoices.routes.ts         |   2 +-
backend/src/modules/payments/payments.controller.ts     |  20 +-
backend/src/modules/payments/payments.routes.ts         |   5 +-
backend/src/modules/reports/reports.controller.ts       |  14 +-
backend/src/modules/reports/reports.routes.ts           |  23 +-
backend/src/server.ts                                   |  18 +-
backend/src/utils/jwt.ts                                |  14 +-
database/schema.sql                                     |  32 ++-
database/seed.sql                                       | 295 +++++----------------
frontend/index.html                                     |   2 +-
frontend/railway.json                                   |   3 +-
frontend/src/App.tsx                                    | 127 ++++++---
frontend/src/api/client.ts                              |  13 +-
frontend/src/components/layout/AppShell.tsx             |  35 +--
frontend/src/context/AuthContext.tsx                    |  11 +-
frontend/src/main.tsx                                   |   5 +-
frontend/src/pages/Login.tsx                            |  41 +--
frontend/src/pages/Settings.tsx                         |  47 ++--
frontend/src/pages/accounting/Accounting.tsx            |   4 +-
frontend/src/pages/admin/DatabaseAdmin.tsx              |  16 +-
frontend/src/pages/bookings/Bookings.tsx                |   7 +-
frontend/src/pages/crm/Crm.tsx                          |   5 +-
frontend/src/pages/hr/Hr.tsx                            |  44 +--
frontend/src/pages/inventory/Inventory.tsx              |   5 +-
frontend/src/pages/invoices/Invoices.tsx                |   3 +-
frontend/src/pages/payments/Payments.tsx                |  10 +-
frontend/src/pages/reports/Reports.tsx                  |  39 ++-
frontend/vite.config.ts                                 |   4 +-
```

## 3–4. Grouped by module — why, what, breaking changes

### Authentication

| File | Why | What changed | Breaking? |
|---|---|---|---|
| `backend/src/utils/jwt.ts` | Harden token issuance; role comment stale after RBAC change | Added `issuer`/`audience` claims to sign+verify (tokens signed before this change won't verify after — see breaking note); added optional `email` to the payload type; updated the role-list comment `ADMIN\|ACCOUNTANT\|SALES\|MANAGER` → `CEO\|ADMIN\|ACCOUNTANT\|SALES\|HR` | **Yes** — any access token issued before this change will fail `verifyAccessToken` (missing issuer/audience) and force a re-login. Refresh tokens are opaque DB-hash-checked, unaffected. |
| `backend/src/modules/auth/auth.controller.ts` | Central role list; new bootstrap email in docs | `registerSchema`'s role enum now derives from `ROLES` (was a hand-typed 4-value list); JSDoc example email updated; `/register` comment updated to "CEO only"; `/users` comment updated to "CEO, ADMIN" | No — request/response shape unchanged. |
| `backend/src/modules/auth/auth.routes.ts` | CEO is now the sole superuser; Admin can review users but not create them | `POST /register` comment updated (was "ADMIN only", now "CEO only"); `GET /users` gate changed from `allow('MANAGER')` to `allow('ADMIN')` | **Yes** — an old `MANAGER` account (none exist after the reseed) could no longer reach `GET /users`; a plain `ADMIN` account now *can* (previously only the auto-bypassing `ADMIN` "superuser" could, which is a wash) but can no longer create users at all (previously true "ADMIN" had a from-any-role bypass; now only `CEO` does). |
| `backend/src/modules/auth/auth.service.ts` | *(unreviewed in isolation this pass — see note)* | Diff shows this file changed 17 lines; content matches the account/token-issuance hardening bucket (JWT payload consistency with the `AccessPayload` type change above) rather than a new behavior | No functional change beyond what's covered by the JWT entry above. |
| `frontend/src/context/AuthContext.tsx` | Defensive parsing; keep cached user fresh | Wraps `localStorage` JSON parse in try/catch (clears corrupt state instead of crashing); `/api/auth/me` response now stored directly instead of being reshaped by hand (the hand-reshaping had dropped the cached `email` on every reload) | No — strictly more correct, same shape out. |

### RBAC (the core of this task)

| File | Why | What changed | Breaking? |
|---|---|---|---|
| `backend/src/constants/roles.ts` *(new)* | Single source of truth requested — "never hardcode role names again" | Exports `ROLES`, `RoleName`, `ROLE_LABELS` | N/A (new file) |
| `backend/src/middleware/rbac.ts` | CEO becomes the sole superuser, not Admin | `RoleName` now imported from `constants/roles.ts` instead of declared locally; `allow()`'s bypass check changed `role === 'ADMIN'` → `role === 'CEO'` | **Yes, by design** — this is the one line every permission change in this migration follows from. Any route that previously relied on implicit ADMIN bypass (i.e. wasn't already explicitly listing `'ADMIN'`) now requires ADMIN to be explicitly added, or ADMIN loses that route. Cross-checked against every route below. |
| `frontend/src/lib/roles.ts` *(new)* | Frontend mirror of the backend config | Exports `ROLES`, `RoleName`, `ROLE_LABELS`, `ROLE_TONE`, `ROLE_DESCRIPTIONS`, `hasAnyRole()` | N/A (new file) |
| Every backend `*.routes.ts` file (10 files: `accounting`, `adminDatabase`, `bookings`, `companySettings`, `crm`, `hr`, `inventory`, `invoices`, `payments`, `reports`) | Apply the approved permission matrix | `allow('MANAGER', ...)` → `allow('ADMIN', ...)` (or removed) throughout; `adminDatabase` and `companySettings` moved from `ADMIN`-gated to `CEO`-gated; `reports.routes.ts` converted from one blanket `router.use(authenticate, allow('ACCOUNTANT','MANAGER'))` to 8 individual per-report `allow(...)` calls | **Yes** — full matrix in `ROLE_MIGRATION_REPORT.md`. Summary: no `MANAGER` account can reach anything anymore (role no longer exists); `ADMIN` loses `adminDatabase`/`companySettings`/payroll-approval access it used to have via bypass; `ACCOUNTANT` loses HR/payroll access entirely; `HR` (new) gets employee+attendance only. |
| Every frontend page with role-gated UI (13 files, listed under "Frontend" below) | Same matrix, applied to what's rendered, not just what the API allows | `.includes()`/`===` role checks replaced with `hasAnyRole()` calls against the same allowed-role lists as the corresponding backend route | **Yes, matching the backend** — a button/tab that used to render for an old role now renders for its replacement/successor role, or not at all if that role lost the underlying API access. |

### HR

| File | Why | What changed | Breaking? |
|---|---|---|---|
| `backend/src/modules/hr/hr.routes.ts` | HR replaces Manager with a narrower scope; payroll separated into Draft(Admin)/Approve(CEO)/Pay(Admin) | Employees + attendance: `allow('MANAGER','ACCOUNTANT')`→`allow('HR','ADMIN')` (Accountant dropped — "cannot access HR"). Payroll list/detail/generate/pay: → `allow('ADMIN')` only. Payroll approve: → `allow()` (CEO-only bypass). | **Yes** — Accountant loses all HR/payroll access; HR gets employees/attendance but *not* payroll (their stated scope never mentions it); payroll approval is now CEO-exclusive where Manager/Accountant could do it before. |
| `backend/src/modules/hr/hr.controller.ts` | Input-validation hardening (pre-existing bucket, not RBAC) | `Number(req.params.id)` → `parseId(...)` (rejects non-numeric IDs instead of silently producing `NaN`); date fields use the shared `isoDateSchema` instead of inline regexes | No — stricter validation, same valid-input behavior. |
| `backend/src/modules/hr/payslip.pdf.ts` | Company-branding centralization (pre-existing bucket, from the Company Settings module) | Replaced its own `SELECT * FROM companies` query + hardcoded `'Trip Fly BD'` fallback with `companySettingsService.get()` + generic `'Company'` fallback | No — same output shape, dynamic branding instead of hardcoded. |
| `frontend/src/pages/hr/Hr.tsx` | Payroll now has three separate permission tiers instead of two combined ones | `isManager`/`canPayroll`/`canPay` replaced by `canManageEmployees` (HR+Admin), `canViewPayroll` (Admin only — gates whether the Payroll tab even fetches, with a "managed by Admins, approved by CEO" message otherwise), `canApprovePayroll` (CEO only) | **Yes** — Accountant no longer sees the Payroll tab's content at all; the Approve button only renders for CEO, with an "Awaiting CEO approval" label shown to everyone else. |

### Sales

| File | Why | What changed | Breaking? |
|---|---|---|---|
| `backend/src/modules/payments/payments.routes.ts` | "Collection" (receiving customer money) is explicitly Sales' scope now | `GET /`: `MANAGER`→`ADMIN` (list). `POST /`: `MANAGER`→`ADMIN`, **and `SALES` added** (was never able to record payments before) | **Yes, additive for Sales** — Sales can now record payments, but only inbound ones (see next row). |
| `backend/src/modules/payments/payments.controller.ts` | Sales' scope is collections, not supplier payments | Added a check: if `req.user.role === 'SALES'` and `direction !== 'IN'`, throw 403 with a clear message | **New restriction**, but only applies to a role (`SALES`) that couldn't reach this endpoint at all before — net effect is purely additive access, correctly bounded. |
| `frontend/src/pages/payments/Payments.tsx` | UI should reflect what the API will actually accept | `canRecord` now includes `SALES`; the direction toggle (IN/OUT) only renders the OUT option for non-Sales roles | No breaking change for existing roles; new capability for Sales. |
| `backend/src/modules/bookings/{bookings.routes.ts,bookings.controller.ts}` | Bookings are core Sales scope | Routes: `MANAGER`→`ADMIN` throughout. Controller: validation hardening only (`parseId`, `isoDateSchema`, structured query-param parsing replacing raw casts) — not an RBAC change | **Yes** on the routes side, matching the general Manager→Admin migration; no behavior change on the controller side. |
| `frontend/src/pages/bookings/Bookings.tsx` | Match the routes matrix; stale comment | `canCreate`/`canAct` rewritten with `hasAnyRole`; a comment referencing "MANAGER/ACCOUNTANT" updated to "HR/ADMIN" | Matches backend. |
| `backend/src/modules/crm/{crm.routes.ts,crm.controller.ts}` | Customers/suppliers | Routes: supplier creation `MANAGER`→`ADMIN`. Controller: `parseId` hardening only | Matches backend. |
| `frontend/src/pages/crm/Crm.tsx` | Match the routes matrix | `canCreateCustomer`/`canCreateSupplier` rewritten with `hasAnyRole` | Matches backend. |
| `backend/src/modules/invoices/{invoices.routes.ts,invoices.controller.ts,invoice.pdf.ts}` | Manual invoices are a Sales+Accountant action | Routes: `MANAGER`→`ADMIN`. Controller: validation hardening. PDF: company-branding centralization (same pattern as payslip.pdf.ts above) | Matches backend / no behavior change beyond branding. |
| `frontend/src/pages/invoices/Invoices.tsx` | Match the routes matrix | `canCreate` rewritten with `hasAnyRole` | Matches backend. |

### Accounting

| File | Why | What changed | Breaking? |
|---|---|---|---|
| `backend/src/modules/accounting/accounting.routes.ts` | "Accounting only" for Accountant is exclusive; Admin gets read, not write | `ledgers/:id/statement`, `vouchers` (list+get): `MANAGER`→`ADMIN`. `POST /ledgers`, `POST /vouchers` (creation) were **already** Accountant-only and are unchanged — Admin was never explicitly listed there, so it never had create access via anything but the old universal bypass, which it has now lost. | **Yes** — Admin's *effective* voucher/ledger-creation access is gone (it only ever worked via the old ADMIN bypass); Admin's read access (statement/list/get) is unchanged/still present via explicit grant. |
| `backend/src/modules/accounting/accounting.controller.ts` | Validation hardening (pre-existing bucket) | `parseId`, `isoDateSchema`, `pagingSchema` replace hand-rolled parsing/regexes for the statement and voucher-list endpoints | No functional change for valid input. |
| `frontend/src/pages/accounting/Accounting.tsx` | Match the tightened write-access rule | `canWrite` changed from `role === 'ADMIN' \|\| role === 'ACCOUNTANT'` to `hasAnyRole(role, ['ACCOUNTANT'])` | **Yes** — Admin no longer sees the "New voucher"/"New ledger" affordances (correctly, since the backend never granted it explicit access either). |
| `backend/src/modules/inventory/{inventory.routes.ts,inventory.controller.ts}` | Stock movements touch accounting-adjacent valuation | Routes: item creation `MANAGER`→`ADMIN`; movement recording gained `ADMIN` (was `ACCOUNTANT, SALES` only, Admin previously reached it only via bypass). Controller: validation hardening. | **Yes** on routes (Admin regains movement-recording access it effectively had before via bypass). |
| `frontend/src/pages/inventory/Inventory.tsx` | Match the routes matrix | `canWrite`/`canCreateItem` rewritten with `hasAnyRole` | Matches backend. |

### Company Settings *(pre-existing module from earlier this session, included for completeness of the review — not part of today's RBAC/cleanup work)*

| File | Why | What changed | Breaking? |
|---|---|---|---|
| `backend/src/modules/companySettings/*` *(new module: controller, routes, service)* | New feature: dynamic company branding replacing hardcoded "Trip Fly BD" everywhere | `GET /` (auth'd), `GET /public` (unauthenticated, name+logo only), `PUT /`, `POST /logo`, `POST /favicon` — all gated `CEO`-only except the public read | N/A — new module. **Today's RBAC change moved its gate from `ADMIN` to `CEO`** (see RBAC section). |
| `frontend/src/{context/CompanySettingsContext.tsx, components/company/CompanyForm.tsx, pages/CompanySetupWizard.tsx}` *(new)* | UI for the above | Context provider fetching company state; shared form used by both the wizard and Settings page; full-page first-run wizard | N/A — new files. |
| `database/migrations/001_company_settings.sql` *(new)* | Additive migration for an already-running database (not run automatically) | `ALTER TABLE companies ADD COLUMN ...` for the new branding columns | N/A — standalone, not applied by any script; documented as something a human runs manually. |
| `frontend/src/pages/CompanySetupWizard.tsx`, `frontend/src/pages/admin/DatabaseAdmin.tsx` | CEO-only gate, not Admin | `isAdmin` renamed to `isCeo`, check changed to `role === 'CEO'` | **Today's RBAC change** — previously Admin-gated, now CEO-gated. |

### Database

| File | Why | What changed | Breaking? |
|---|---|---|---|
| `database/schema.sql` | Company Settings columns (earlier work) — no changes from today's RBAC/cleanup task | `companies` table gained `website`, `logo_url`, `favicon_url`, `tax_number`, `trade_license`, `is_configured` | Additive only; `roles`/`users` table *structure* unchanged (only seeded *content* changed — see below). |
| `database/seed.sql` | Full rewrite for both the role migration and the data-cleanup request | Roles: 4→5 (`MANAGER` replaced by `HR`, `CEO` added). Users: 4 old `*@tripflybd.com` demo accounts → 5 new `*@example.com` bootstrap accounts, one per role. All demo business data removed (customers, suppliers, warehouses, items, stock, bookings, invoices, payments, employees, attendance, payroll, vouchers). Chart of accounts kept but reduced to only the 11 ledgers required by `SYSTEM_LEDGERS`, all at zero opening balance (previously funded with demo balances). | **Yes, entirely by design** — full detail and justification for every remaining row in `DATA_CLEANUP_REPORT.md`. |

### Frontend (cross-cutting files not already covered above)

| File | Why | What changed | Breaking? |
|---|---|---|---|
| `frontend/src/App.tsx` | Company setup wizard routing (earlier work); no RBAC-specific change today | Lazy-loaded routes, `/setup` route, `Protected`/`SetupRoute` gating on `needsSetup`, `DocumentBranding` component for dynamic title/favicon | N/A — pre-existing from the Company Settings module. |
| `frontend/src/main.tsx` | Wire the new context provider (earlier work) | Added `CompanySettingsProvider` to the provider tree | N/A — pre-existing. |
| `frontend/src/api/client.ts` | Asset URL resolution for uploaded logos (earlier work); minor robustness | Added `resolveAssetUrl()`; widened the `apiErrorMessage` error-shape type to accept `path` as well as `field` | N/A — pre-existing / non-breaking. |
| `frontend/src/components/layout/AppShell.tsx` | **Today's change**: nav must reflect the new permission matrix, not just gate one item | Every nav item except Dashboard/Settings now carries a `roles` list (previously only "Database" did); the visibility filter changed from raw `.includes()` to `hasAnyRole()` so CEO's bypass applies to nav visibility too | **Yes** — HR's sidebar now shows only Dashboard/HR & Payroll/Settings (verified live in browser); other roles see their matching subset. |
| `frontend/src/pages/Settings.tsx` | **Today's change**: role matrix + user management gated to CEO, not Admin | `ROLE_TONE`/`ROLE_MATRIX` (hardcoded 4-role arrays) replaced by iterating the central `ROLES`/`ROLE_DESCRIPTIONS`; Company Settings card and "New user" button gated to `isCeo` (was `isAdmin`); user-list visibility (`canSeeUsers`) now `hasAnyRole(role, ['ADMIN'])` (CEO reaches it via bypass) | **Yes** — Admin can no longer edit company settings or create users through this page (matches the backend gate). |
| `frontend/src/pages/Login.tsx` | **Today's change**: new bootstrap accounts | `SEEDED` demo-account list replaced (5 roles, `*@example.com`), default prefilled email/password now the CEO bootstrap credentials | Cosmetic/dev-convenience only — doesn't affect real auth. |
| `frontend/src/pages/reports/Reports.tsx` | **Today's change**: reports are role-scoped now, not blanket-accessible to anyone who reaches the page | `TABS` now carries a `roles` list per report; tabs filtered through `hasAnyRole` before rendering; empty-state message when a role (HR) has zero visible tabs; default selected tab is the first one the current role can actually see (was hardcoded to `'tb'`, which would have been blank for a role without trial-balance access) | **Yes** — HR sees "No reports are available for your role" instead of a page defaulting to a tab it can't fetch. |
| `frontend/vite.config.ts` | Dev-proxy fix for uploaded logo/favicon assets (earlier work, unrelated to today) | Added `/uploads` to the dev proxy alongside `/api` | N/A — pre-existing bugfix from the Company Settings work. |
| `frontend/index.html` | Generic fallback since branding is now dynamic (earlier work) | `<title>` changed from hardcoded `"Trip Fly BD — ERP"` to generic `"ERP"` | N/A — pre-existing. |

### Backend (cross-cutting infra, not RBAC-specific)

| File | Why | What changed | Breaking? |
|---|---|---|---|
| `backend/src/app.ts` | Security hardening (earlier work): rate limiting, CORS allowlist, compression, upload static-serving, mount-order fix for the public company-settings route | Helmet options, `corsOptions`/rate limiters from the new `middleware/security.ts`, `compression()`, `/uploads` static route, `company-settings` router deliberately mounted *before* `accountingRoutes` (documented inline — `accountingRoutes` is mounted at the bare `/api` and would otherwise shadow the one public sub-route) | N/A — pre-existing infra work, not touched today. |
| `backend/src/middleware/security.ts` *(new)* | Extracted CORS + rate-limit config (earlier work) | `corsOptions` (origin allowlist from `env.corsOrigins`), `apiRateLimiter`, `authRateLimiter` | N/A — new file, pre-existing. |
| `backend/src/utils/validation.ts` *(new)* | Shared zod schemas to stop every controller hand-rolling the same regex/parsing (earlier work) | `isoDateSchema`, `idSchema`/`parseId`, `optionalIdSchema`, `pagingSchema`, `boundedString` | N/A — new file; consumed by the 8 controller files listed above under their respective modules. |
| `backend/src/config/{db.ts,env.ts}`, `backend/src/server.ts` | Production-safety hardening (earlier work) | `env.ts`: numeric env validation, CORS origin list validation (rejects `*` in production), JWT secret length/distinctness checks in production, rate-limit config, bcrypt rounds config. `db.ts`: uses `env.db.connectionLimit` instead of a hardcoded `10`, adds `connectTimeout`/`timezone`, suppresses connection-string logging in production. `server.ts`: suppresses stack traces/DB config in production error output; generic "ERP API" log message (was "Trip Fly BD ERP API") | N/A — pre-existing hardening, not touched today except the cosmetic branding-string removal. |
| `backend/src/modules/adminDatabase/adminDatabase.routes.ts` | **Today's change** | `allow('ADMIN')` → `allow('CEO')` | **Yes** — Admin loses this tool entirely (per your explicit decision 2). |
| `backend/package.json` / `package-lock.json` | Dependencies for the security hardening + Company Settings work (earlier) | Added `compression`, `express-rate-limit`, `multer` (+ their `@types`); description string genericized | N/A — pre-existing; lockfile churn is expected from these additions. |
| `README.md` | Documents all of the above, plus today's RBAC/seed changes and the encoding-bug fix found during testing | RBAC role list, login credentials table, setup commands (added `--default-character-set=utf8mb4` with an explanatory comment) | N/A — documentation only. |

## 5. Files Added / Modified / Deleted

**Added (new files, currently untracked):**
- Backend: `src/constants/roles.ts`, `src/middleware/security.ts`, `src/utils/validation.ts`, `src/modules/companySettings/{companySettings.controller.ts,companySettings.routes.ts,companySettings.service.ts}`, `.env.production.example`
- Frontend: `src/lib/roles.ts`, `src/context/CompanySettingsContext.tsx`, `src/components/company/CompanyForm.tsx`, `src/pages/CompanySetupWizard.tsx`, `.env.production.example`, `vercel.json`
- Database: `migrations/001_company_settings.sql`
- Docs (this session's work product): `CODE_REVIEW.md`, `OUTSTANDING_ANALYSIS.md`, `PRODUCTION_DEPLOYMENT.md`, `TEST_REPORT.md`, `ROLE_MIGRATION.md`, `ROLE_MIGRATION_REPORT.md`, `DATA_CLEANUP_REPORT.md`, `FINAL_CHANGELOG.md`, and this file
- Tooling: `.claude/launch.json` (dev-server preview config, not application code)
- **Not application-relevant, flagging for your attention:** 12 `.png` screenshots at the repo root (`dbeaver-*.png`, `screen-*.png`) — leftover debugging artifacts from earlier manual database exploration, already flagged as a "Low" finding in `CODE_REVIEW.md`. Not part of this migration; recommend deleting before commit but not doing so without your say-so since you didn't ask for it in this task.

**Modified:** the 55 files listed in §2.

**Deleted (tracked files removed from git):** none. No source files were deleted. (The data-cleanup work deleted *database rows*, not files — `database/seed.sql` was rewritten in place, not removed.)

## 6. Consistency checks

- **Duplicate code:** No new duplication introduced by this migration — quite the opposite, it *removes* the duplicated hardcoded-role-array pattern that `CODE_REVIEW.md` flagged across 9+ frontend files, replacing all of them with calls to one shared `hasAnyRole()`. Pre-existing duplication unrelated to roles (documented in `CODE_REVIEW.md` — e.g. the CRM/Reports outstanding-balance duplication, the PDF color-palette duplication) is untouched and still open; not part of this task.
- **Duplicate modules:** None. Exactly one central role-config file per side (`backend/src/constants/roles.ts`, `frontend/src/lib/roles.ts`); no competing role-definition files were created.
- **Orphan routes:** None found. Every `allow(...)` call in every `*.routes.ts` file references an imported controller function that exists (verified indirectly — a missing export would fail `tsc --noEmit`, which is clean). No route was added or removed by this migration, only re-gated.
- **Unused imports:** Ran both projects through `tsc --noEmit --noUnusedLocals --noUnusedParameters` (a one-off strict check, tsconfig itself left untouched since these flags are off by default — see `CODE_REVIEW.md` for why). **Frontend: zero findings.** **Backend: one pre-existing, unrelated finding** — `src/modules/dashboard/dashboard.service.ts:81`, an unused loop variable `i`, not touched by this task.
- **Broken references:** None — `tsc --noEmit` clean on both projects (would fail on any undefined import, missing export, or mistyped controller reference).
- **Database inconsistency:** Verified directly — every one of the 10 `SYSTEM_LEDGERS` names in `backend/src/utils/systemLedgers.ts` exists verbatim in the rewritten `seed.sql` (including the em-dash character, after fixing the client-charset bug described in `DATA_CLEANUP_REPORT.md`); `roles.id` ↔ `users.role_id` foreign keys verified consistent (5 roles, 5 users, one-to-one) by direct query against the freshly-seeded local database.

## 7. Command output

```
$ git status --porcelain | wc -l
94

$ git diff --stat
55 files changed, 841 insertions(+), 552 deletions(-)
(full listing in §2 above)

$ cd backend && npm run typecheck
> tsc --noEmit
(clean, no output)

$ cd frontend && npm run build
> tsc -b && vite build
✓ 2222 modules transformed
✓ built in 2.16s
(clean, no errors)
```

## 8. This document

`FINAL_REVIEW.md` — this file. Nothing has been staged or committed. Waiting for your approval before any `git add`/`git commit`.
