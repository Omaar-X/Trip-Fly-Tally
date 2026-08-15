# Company Settings Module — Test Report

**Date:** 2026-07-29
**Environment:** Local dev only — `backend/.env` → `root@127.0.0.1:3306/tripfly_erp` (confirmed local before touching anything; production was never connected to)
**Scope:** New Company Settings module (schema, backend API, setup wizard, branding propagation)

## Setup performed

- Started local MySQL 8.4 (`C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe`, existing datadir at `C:\ProgramData\MySQL\MySQL Server 8.4\Data`) — it was not running when this session started.
- Applied `database/schema.sql` then `database/seed.sql` to the local `tripfly_erp` database. This **replaced pre-existing local dev data** (3 users, 2 customers, 3 employees, ledgers, etc. — leftover from earlier manual/DBeaver testing) with the fresh schema + demo seed, as explicitly instructed.
- Started backend (`npm run dev`, port 4000) and frontend (`npm run dev`, port 5173) dev servers.

## Passed

| # | Test | Result |
|---|---|---|
| 1 | Login as `admin@tripflybd.com` | Redirects to `/setup` (company `is_configured = 0` after fresh seed) |
| 2 | Company Setup Wizard — fill + submit (Trip Fly BD, https://tripflybd.com, info@tripflybd.com, +8801672710556, Dhaka, Bangladesh) | `PUT /api/company-settings` → 200, redirects to Dashboard, page title → "Trip Fly BD — ERP", sidebar brand name/footer address update immediately |
| 3 | Logo upload (`POST /api/company-settings/logo`, 1×1 PNG test file) | 200, `logo_url` set, file served and rendered in the sidebar (`naturalWidth: 1` after proxy fix) |
| 4 | Invoice PDF branding (`GET /api/invoices/1/pdf`, seeded INV-2026-0001) | Brand band shows "Trip Fly BD" / "Dhaka, Bangladesh • +8801672710556 • info@tripflybd.com" — pulled live from `companies`, not hardcoded |
| 5 | Payroll approval workflow regression (generate → approve for May 2026, using seeded attendance) | Generates run, posts voucher `JV-2026-00003`, approves cleanly — confirms the schema change (new `companies` columns) didn't break unrelated FK-dependent flows |
| 6 | Payslip PDF branding (`GET /api/hr/payslips/1/pdf`) | Brand band shows "Trip Fly BD" correctly |
| 7 | Audit trail | `COMPANY_SETTINGS_UPDATE`, `COMPANY_SETTINGS_LOGO_UPDATE`, `PAYROLL_GENERATE`, `PAYROLL_APPROVE` all logged with correct user/entity in `audit_logs` |
| 8 | Direct DB check | `SELECT * FROM companies` matches exactly what was submitted through the wizard |
| 9 | Non-DB frontend render (from earlier in this session, before DB was available) | Login page renders cleanly with generic "Company" fallback and no console errors when the backend is unreachable |
| 10 | Backend `tsc --noEmit` / frontend `tsc -b && vite build` | Both clean |

## Failed → Fixed

### Bug 1 — `GET /api/company-settings/public` returned 401 instead of being public
- **Cause:** `backend/src/app.ts` mounted `accountingRoutes` at the bare `/api` prefix (registered before the company-settings router), and that router runs `router.use(authenticate)` unconditionally. Express matches by registration order, so any unauthenticated `/api/...` request hit that blanket `authenticate` before ever reaching the intentionally-public route. Invisible until now because no other route under `/api` was ever meant to skip auth.
- **Fix:** reordered `app.use('/api/company-settings', companySettingsRoutes)` to before `app.use('/api', accountingRoutes)` in `backend/src/app.ts`. One-line change, no risk to `accountingRoutes`' own routes (`/ledger-groups`, `/ledgers`, `/vouchers` — no overlap).
- **Verified:** `curl http://localhost:4000/api/company-settings/public` → 200 after the fix.

### Bug 2 — Uploaded logo/favicon 404'd in local dev
- **Cause:** `frontend/vite.config.ts` only proxied `/api` to the backend. In dev, `VITE_API_URL` is intentionally empty (relies on the proxy), so `resolveAssetUrl()` returned a bare `/uploads/...` path that resolved against the frontend's own origin (`:5173`) instead of the backend (`:4000`), and nothing proxied it. Production is unaffected — there `VITE_API_URL` is set to the real backend URL.
- **Fix:** added `/uploads` to the same Vite dev proxy as `/api`.
- **Verified:** re-uploaded the test logo after restarting the dev server; image `naturalWidth` went from `0` to `1` (loads correctly).

## Cleanup performed

- Deleted the test logo upload: cleared `companies.logo_url` back to `NULL` and removed the physical file (`backend/uploads/company/logo-*.png`).
- Deleted the test payroll run generated for the approval-workflow check: removed its `payslips` row, `payroll_runs` row, the posted voucher (`JV-2026-00003`), and its `voucher_entries`. Verified afterward: `vouchers` = 5, `voucher_entries` = 10, `payroll_runs` = 0, `payslips` = 0 — matches `seed.sql` exactly.
- **Not touched (kept):** the real company data entered through the wizard (Trip Fly BD / tripflybd.com / etc. — this is the actual data you provided, not test data) and the `audit_logs` trail (append-only by design; left as an accurate record of the actions taken during this verification).

## Remaining issues / not covered

- The actual file-picker upload interaction in the browser UI wasn't automated (the available browser tooling has no file-input control here) — the upload was exercised via a real `fetch`/`FormData` call from the page's own JS context instead, which covers the same backend path (multer parsing → mimetype check → disk write → DB update → frontend render) but not literally clicking the `<input type="file">`.
- Favicon upload wasn't separately tested (same code path as logo, high confidence it works, but not directly exercised).
- Non-admin "waiting for admin" screen on `/setup` wasn't exercised in the browser (covered by code review, not a live click-through).
- MySQL is running as a manually-started foreground process (not a registered Windows service) — it will stop if the machine restarts or the process is killed. Backend and frontend dev servers were left running after this verification so you can continue poking at the app; stop them yourself when done.
