# Production Fix Report

**Date:** 2026-07-30
**Scope:** Remediation of the Medium and Low findings raised in `PRODUCTION_READINESS_REPORT.md`. No new features were added and nothing outside the approved findings was touched. Nothing was committed — this is a working-tree change awaiting your final approval.

---

## MEDIUM 1 — Legacy "tripfly-erp" identifiers removed

Every internal identifier that hardcoded the old product name is now derived from a single configurable `APP_SLUG` environment variable (default `erp`), added to `backend/src/config/env.ts` as `env.appSlug`.

| Identifier | Before | After |
|---|---|---|
| JWT issuer | `'tripfly-erp-api'` (hardcoded) | `env.jwt.issuer`, defaults to `` `${appSlug}-api` ``, overridable via `JWT_ISSUER` |
| JWT audience | `'tripfly-erp'` (hardcoded) | `env.jwt.audience`, defaults to `appSlug`, overridable via `JWT_AUDIENCE` |
| DB name fallback | `'tripfly_erp'` (hardcoded) | `` `${appSlug}_db` `` |
| Health-check service id | `'tripfly-erp-api'` (hardcoded) | `` `${env.appSlug}-api` `` |
| Admin-DB backup filename (backend) | `tripfly_erp-backup-...json` | `` `${env.appSlug}-backup-...json` `` |
| Admin-DB backup filename (frontend) | `tripfly_erp-backup-...json` | `erp-backup-...json` |
| npm package names | `tripfly-erp-backend` / `tripfly-erp-frontend` | `erp-backend` / `erp-frontend` (`package.json` + `package-lock.json`) |

**Files changed:** `backend/src/config/env.ts`, `backend/src/utils/jwt.ts`, `backend/src/app.ts`, `backend/src/modules/adminDatabase/adminDatabase.controller.ts`, `frontend/src/pages/admin/DatabaseAdmin.tsx`, `backend/package.json`, `frontend/package.json`, `backend/package-lock.json`, `frontend/package-lock.json`, `backend/.env.example`, `backend/.env.production.example`, `README.md` (setup commands updated to reference the new default DB name `erp_db` instead of `tripfly_erp`, so the docs stay consistent with the code — the README's title and business-domain description were deliberately left alone, since those describe this actual deployment rather than a hardcoded internal identifier).

**Note on scope:** the README's project title ("TRIP FLY BD — Travel Agency ERP") and its description of travel-industry features (bookings, VAT invoicing, etc.) were left unchanged. Those describe what this specific application actually is and who it's for — not an internal/technical identifier leaking a placeholder product name, which is what the finding was about.

**Verification:** `grep -rn "tripfly_erp\|tripfly-erp" backend/src frontend/src` returns zero matches. New tests (`backend/test/jwt.test.ts`, `backend/test/health.test.ts`) assert the identifiers are generic and configurable, and will fail if this regresses.

---

## MEDIUM 2 — Role string literals replaced with centralized RBAC constants

Added a `ROLE` object to both `backend/src/constants/roles.ts` and `frontend/src/lib/roles.ts`:

```ts
export const ROLES = ['CEO', 'ADMIN', 'ACCOUNTANT', 'SALES', 'HR'] as const;
export const ROLE: { [K in RoleName]: K } = Object.fromEntries(ROLES.map((r) => [r, r])) as { [K in RoleName]: K };
```

`ROLE` is derived programmatically from `ROLES`, so `ROLES` remains the *only* place a role name is spelled as a literal string. Every call site was then updated from a raw literal to the derived accessor, e.g. `allow('ADMIN', 'HR')` → `allow(ROLE.ADMIN, ROLE.HR)`, `hasAnyRole(role, ['ACCOUNTANT'])` → `hasAnyRole(role, [ROLE.ACCOUNTANT])`, `role === 'CEO'` → `role === ROLE.CEO`.

**Files changed (backend, 13):** `middleware/rbac.ts`, all 11 `*.routes.ts` files (`auth`, `accounting`, `adminDatabase`, `bookings`, `companySettings`, `crm`, `hr`, `inventory`, `invoices`, `payments`, `reports`), `modules/payments/payments.controller.ts`.

**Files changed (frontend, 13):** `lib/roles.ts` (added `ROLE` + updated its own `hasAnyRole()` to use it), `components/layout/AppShell.tsx`, `pages/{Settings,Login,CompanySetupWizard,admin/DatabaseAdmin,accounting/Accounting,reports/Reports,hr/Hr,crm/Crm,invoices/Invoices,inventory/Inventory,payments/Payments,bookings/Bookings}.tsx`.

**Login.tsx special case:** its demo-account picker previously hardcoded `{ role: 'CEO' | 'Admin' | 'Accountant' | ... }` as untyped display strings. It now derives its list from `ROLES.map(...)`, with a small `Record<RoleName, string>` map (`DEMO_SHORT_LABEL`) for the compact display labels — typed against `RoleName`, so a stale/misspelled role fails `tsc` immediately, matching the existing `ROLE_TONE`/`ROLE_LABELS` pattern already used elsewhere in the codebase.

**What remains (by design, not a gap):** `constants/roles.ts` / `lib/roles.ts` themselves (the source of truth), and a handful of `Record<RoleName, ...>` display maps (`ROLE_LABELS`, `ROLE_TONE`, `ROLE_DESCRIPTIONS`, `DEMO_SHORT_LABEL`, `DEMO_COLOR`) — all type-checked against `RoleName`, so they can't silently drift from the role list. Unrelated `'SALES'` occurrences in voucher/transaction-type enums (`accounting.controller.ts`, `invoices.service.ts`, `bookings.service.ts`) were correctly left alone — that's a transaction-type value, not a role name.

**Verification:** `grep -n "'CEO'\|'ADMIN'\|'ACCOUNTANT'\|'SALES'\|'HR'"` across `backend/src` and `frontend/src` (excluding the two source-of-truth files) turns up nothing but typed display maps and the unrelated voucher-type enum. `tsc --noEmit` clean on both projects.

---

## MEDIUM 3 — Minimal automated test suite added

### Backend — vitest + supertest (`backend/test/`, 9 files, 34 tests, `npm test`)

| Area | File | What it covers |
|---|---|---|
| RBAC | `rbac.test.ts` | `allow()` middleware unit tests: CEO bypass, explicit-role allow, role-mismatch → 403, no-role → 401 |
| Authentication | `jwt.test.ts` | Sign/verify round trip, rejects wrong issuer/secret/garbage — doubles as a regression guard for the Medium #1 identifier fix |
| Authentication | `auth-middleware.test.ts` | `authenticate()` unit tests: missing/malformed/invalid/valid tokens |
| Authentication | `auth-login.test.ts` | `POST /api/auth/login` via supertest (service layer mocked): success, invalid credentials, malformed body |
| API health | `health.test.ts` | `GET /api/health` returns the generic, configurable service id |
| RBAC (routes) | `rbac-routes.test.ts` | 401/403 boundary on real routes across admin-database, accounting, payroll-approval, company-settings, and HR endpoints — no mocking needed since `allow()` rejects before any DB access |
| Company Settings | `company-settings.test.ts` | Public branding fetch (no auth), CEO can update, non-CEO rejected before the service runs |
| Accounting permissions | `accounting-permissions.test.ts` | ACCOUNTANT can post a balanced voucher; ADMIN/SALES rejected; ungated ledger read confirmed reachable by SALES |
| Payroll approval | `payroll-approval.test.ts` | CEO can approve a DRAFT run; ADMIN/HR rejected; re-approving an already-approved run surfaces a 409 |

Design choice: routes gated by `allow()` are tested for their 401/403 boundary against the **real** Express app and **real** middleware chain, with zero mocking (rejection happens before any service/DB code runs). The handful of "happy path" tests mock the relevant service module (e.g. `hrService`, `accountingService`) rather than raw SQL, so the suite runs without a live MySQL connection — useful for CI and for anyone checking out the repo without a database configured.

### Frontend — vitest + @testing-library/react + jsdom (`frontend/test/`, 3 files, 13 tests, `npm test`)

| Area | File | What it covers |
|---|---|---|
| RBAC (unit) | `lib/roles.test.ts` | `hasAnyRole()` behavior; `ROLE`/`ROLES` consistency |
| Login | `pages/Login.test.tsx` | Company branding rendered dynamically (not hardcoded), fallback to generic "Company" on fetch failure, demo-account picker generated from the centralized role list, credential submission calls the real auth context |
| Navigation visibility / RBAC rendering | `components/AppShell.test.tsx` | CEO sees every nav item (bypass); HR sees only Dashboard/HR & Payroll/Settings; SALES sees its operational subset and not Accounting/HR/Database; sidebar renders dynamic company branding |

**Setup note:** `frontend/test/setup.ts` registers `afterEach(cleanup)` from Testing Library — without it, DOM from earlier tests in the same file accumulates and causes false "found multiple elements" failures. This was caught and fixed during this pass (all 13 tests pass cleanly now).

Both `npm test` scripts are new (`vitest run` / `vitest run --config vitest.config.ts`); nothing else in either `package.json` was reconfigured. New dev dependencies: `vitest`, `supertest`, `@types/supertest` (backend); `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event` (frontend).

---

## LOW 4 — Reports moved to `docs/reports/`

Moved all 11 root-level markdown reports (everything except `README.md`, which stays at the root as the standing project document) into `docs/reports/`: `ADMIN_DATABASE_SECURITY_REPORT.md`, `CODE_REVIEW.md`, `DATA_CLEANUP_REPORT.md`, `FINAL_CHANGELOG.md`, `FINAL_REVIEW.md`, `OUTSTANDING_ANALYSIS.md`, `PRODUCTION_DEPLOYMENT.md`, `PRODUCTION_READINESS_REPORT.md`, `ROLE_MIGRATION.md`, `ROLE_MIGRATION_REPORT.md`, `TEST_REPORT.md`. This report is also written there. Note: `ADMIN_DATABASE_SECURITY_REPORT.md` was already committed in a prior session's commit, so this move shows up in `git status` as a tracked delete + untracked add at the new path (not staged — nothing was committed).

## LOW 5 — Screenshots moved to `docs/debug/`

Moved all 18 debugging screenshots (`dbeaver-*.png` ×12, `screen-*.png` ×6) into `docs/debug/`.

Root directory now contains only `README.md` alongside the standard `backend/`, `frontend/`, `database/` project folders.

---

## LOW 6 — Ledger read endpoints investigated

**`GET /api/ledgers` — confirmed intentional, documented, left unrestricted.**
`frontend/src/pages/invoices/Invoices.tsx:158` fetches this endpoint to populate the "Income ledger" dropdown when creating a manual invoice, and SALES is one of the roles allowed to create invoices (`canCreate = hasAnyRole(user?.role, [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES])`). Any authenticated role genuinely needs read access to this list. Added a comment in `backend/src/modules/accounting/accounting.routes.ts` documenting the reason, so a future reader doesn't mistake it for an oversight.

**`GET /api/ledger-groups` — no current justification found. Proposed fix below, NOT applied — awaiting your approval, per your instructions.**
Grepped the entire frontend for consumers of `/api/ledger-groups`: the only caller is `frontend/src/pages/accounting/Accounting.tsx:51`, which is itself only reachable by ADMIN/ACCOUNTANT (both via nav visibility and because no other page fetches this data). Unlike `/ledgers`, there's no cross-role need for it today.

**Proposed fix (not applied):**
```diff
- router.get('/ledger-groups', c.listGroups);
+ router.get('/ledger-groups', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.listGroups);
```
in `backend/src/modules/accounting/accounting.routes.ts`. This is low risk either way — the data is non-monetary chart-of-accounts structure (group names like "Assets → Current Assets"), not a security hole today — but it would tighten the permission surface to match actual need. **Let me know if you'd like this applied; it was intentionally left out of this pass since you asked for approval before changing anything here.**

---

## Verification (this pass)

```
$ git status
1 tracked delete (moved report) + modified files from this pass; new untracked: backend/test/,
backend/vitest.config.ts, frontend/test/, frontend/vitest.config.ts, docs/.

$ git diff --stat
59 files changed, 3684 insertions(+), 659 deletions(-)

$ cd backend && npm run typecheck
tsc --noEmit — clean, no output.

$ cd backend && npm run build
tsc — clean, no output.

$ cd frontend && npm run typecheck
tsc -b --noEmit — clean, no output.

$ cd frontend && npm run build
tsc -b && vite build — clean, 2222 modules transformed, built in ~2s.

$ cd backend && npm test
vitest run
 Test Files  9 passed (9)
      Tests  34 passed (34)

$ cd frontend && npm test
vitest run --config vitest.config.ts
 Test Files  3 passed (3)
      Tests  13 passed (13)
```

All green. `docs/reports/PRODUCTION_READINESS_REPORT.md` has been updated to reflect this pass's fixes.

## Not done / explicitly deferred

- `GET /api/ledger-groups` gating change — proposed above, not applied, awaiting your decision.
- No new features were added anywhere in this pass.
- Nothing was committed.
- Did not run `npm audit fix` on the newly added dev dependencies. Both projects report a couple of transitive, **dev-only** vulnerabilities pulled in by the new test tooling (`body-parser` via supertest's Express dependency; `brace-expansion` via a glob transitive) — neither ships in the production runtime bundle. Left alone rather than silently bumping versions you didn't ask for; flagged in the updated readiness report's Technical Debt section.
