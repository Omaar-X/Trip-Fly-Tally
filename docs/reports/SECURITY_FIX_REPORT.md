# Security Fix Report

**Date:** 2026-07-30
**Scope:** Closes the one item left open in `PRODUCTION_FIX_REPORT.md` (item 6 / Low #3 in `PRODUCTION_READINESS_REPORT.md`): `GET /api/ledger-groups` had no role gate. Nothing else was touched. Nothing was committed.

---

## Change

`backend/src/modules/accounting/accounting.routes.ts` — added a role gate to the one previously-ungated route that had no confirmed cross-role need:

```diff
- router.get('/ledger-groups', c.listGroups);
+ router.get('/ledger-groups', allow(ROLE.ACCOUNTANT, ROLE.ADMIN), c.listGroups);
```

**Allowed:** CEO (via the `allow()` superuser bypass — never listed explicitly, per the existing convention in this codebase), ADMIN, ACCOUNTANT.
**Denied:** SALES, HR — both now receive `403 Forbidden`.

This matches `GET /ledger-groups`'s only actual consumer, `frontend/src/pages/accounting/Accounting.tsx`, which is itself only reachable by ADMIN/ACCOUNTANT (CEO via bypass). No frontend change was needed: the Accounting page was already nav-gated to those same roles, so no legitimate caller loses access.

`GET /api/ledgers` (the sibling endpoint) was **not** changed — it remains open to any authenticated role by design, since `frontend/src/pages/invoices/Invoices.tsx` (reachable by SALES) depends on it to populate the "Income ledger" dropdown. See `PRODUCTION_FIX_REPORT.md` item 6 for that analysis; it stands unchanged.

## Tests updated

`backend/test/accounting-permissions.test.ts` — added two cases:
- `ledger-group reads are allowed for CEO, ADMIN, ACCOUNTANT` — asserts `200` for all three (service mocked).
- `ledger-group reads are denied for SALES and HR` — asserts `403` for both, and that the service is never invoked (confirming the rejection happens at the `allow()` middleware, before any DB access).

Backend suite grew from 34 to 36 tests; no other test files needed changes.

## Verification

```
$ cd backend && npm test
vitest run
 Test Files  9 passed (9)
      Tests  36 passed (36)

$ cd backend && npm run typecheck
tsc --noEmit — clean, no output.

$ cd backend && npm run build
tsc — clean, no output.

$ cd frontend && npm test
vitest run --config vitest.config.ts
 Test Files  3 passed (3)
      Tests  13 passed (13)

$ cd frontend && npm run typecheck
tsc -b --noEmit — clean, no output.

$ cd frontend && npm run build
tsc -b && vite build — clean, 2222 modules transformed, built in ~2s.
```

All green on both projects.

## Status

This closes the last open item from the production readiness audit. No Critical, High, Medium, or Low findings remain open across `PRODUCTION_READINESS_REPORT.md`, `PRODUCTION_FIX_REPORT.md`, and this report. `docs/reports/PRODUCTION_READINESS_REPORT.md`'s Low #3 has been updated to reflect this fix.

## Not done

- No other code was touched.
- Nothing was committed — this remains a working-tree change awaiting your approval, same as the two prior passes.
