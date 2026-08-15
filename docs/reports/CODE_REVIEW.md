# Code Review — Trip Fly Tally

**Date:** 2026-07-29
**Scope:** Full codebase (`backend/`, `frontend/`, `database/`) — read-only review, no fixes applied.
**Method:** Manual review of the Company Settings module and its integration points (done directly), plus two independent read-only audits covering every remaining backend module and every remaining frontend page/component, plus repo-wide greps for hardcoded strings, duplicate DB tables, and orphaned tables. The two highest-severity claims below were independently re-verified by reading the source before inclusion.

Findings are grouped under the 20 categories requested. Categories with no confirmed issues are marked accordingly — they were checked, not skipped.

---

## 1. Duplicate modules
No duplicate modules found. Each backend module (`accounting`, `auth`, `bookings`, `companySettings`, `crm`, `dashboard`, `hr`, `inventory`, `invoices`, `payments`, `reports`, `adminDatabase`) owns a distinct, non-overlapping domain.

## 2. Duplicate pages
No duplicate pages found. Each frontend page under `frontend/src/pages/` maps 1:1 to a distinct route in `App.tsx`.

## 3. Duplicate components

### Tab-switcher bar reimplemented identically in 5 page files
- **File:** frontend/src/pages/accounting/Accounting.tsx
- **Line:** 64-72
- **Problem:** The same tab-bar markup and className string (`"mb-4 flex gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900 w-fit"`, with an identical active-state class) is copy-pasted in `frontend/src/pages/crm/Crm.tsx:76-86`, `frontend/src/pages/hr/Hr.tsx:47-55`, `frontend/src/pages/inventory/Inventory.tsx:71-79`, and `frontend/src/pages/reports/Reports.tsx:44-52`, instead of a shared component.
- **Severity:** High
- **Recommended Fix:** Extract a `TabBar<T extends string>({ tabs, active, onChange })` component into `frontend/src/components/ui.tsx` and replace all 5 local copies.

## 4. Duplicate APIs
See §17 (Duplicate SQL queries) — `crmService.listCustomers` and `reportsService.customerOutstanding` are two different API endpoints computing the same "customer outstanding balance" concept with diverging results, which is effectively a duplicated API surface with drifted behavior.

## 5. Duplicate routes
No two routes serve identical functionality. See §12 for a route **naming** inconsistency (not a duplicate).

## 6. Duplicate database tables
No duplicate tables found. All 21 tables in `database/schema.sql` (`companies, roles, users, refresh_tokens, audit_logs, ledger_groups, ledgers, vouchers, voucher_entries, customers, suppliers, warehouses, items, stock_entries, bookings, invoices, invoice_items, payments, employees, attendance, payroll_runs, payslips`) represent distinct concepts with no overlapping responsibility.

## 7. Duplicate business logic

### `round2()` exists in `utils/money.ts` but balance rounding is reimplemented inline
- **File:** backend/src/modules/accounting/accounting.service.ts
- **Line:** 79, 82
- **Problem:** `ledgerStatement` computes `Math.round(balance * 100) / 100` inline twice — the exact formula already implemented as `round2()` in `backend/src/utils/money.ts`. The file already imports other helpers from the same module.
- **Severity:** Medium
- **Recommended Fix:** Import and use `round2()` for both `running_balance` and `closing_balance`.

### Cash/Bank ledger-group names hardcoded identically in two files, no shared constant or existence check
- **File:** backend/src/modules/dashboard/dashboard.service.ts
- **Line:** 53
- **Problem:** Literal group names `'Cash-in-Hand'` / `'Bank Accounts'` are hardcoded here and again in `backend/src/modules/reports/reports.service.ts:97`. Unlike ledger names (centralized via `SYSTEM_LEDGERS`/`findLedgerId`, which throws if missing), these have no shared constant and fail silently (empty result) if renamed.
- **Severity:** Medium
- **Recommended Fix:** Add these group names to a shared constants module alongside `SYSTEM_LEDGERS` and reference from both files.

### Customer/supplier-by-id lookup reimplemented three times instead of reusing the existing generic helper
- **File:** backend/src/modules/bookings/bookings.service.ts
- **Line:** 251-269
- **Problem:** `assertCustomer`, `customerLedger`, and `supplierLedger` each run a near-identical `SELECT ... FROM {customers|suppliers} WHERE company_id = ? AND id = ?` + "does not exist" error. A more general version, `partyRow(conn, table, companyId, id)`, already exists in `backend/src/modules/payments/payments.service.ts:127-132`.
- **Severity:** Medium
- **Recommended Fix:** Move `partyRow` into a shared helper and have `bookings.service.ts` reuse it.

### Stock-quantity calculation duplicated between the item list and the stock-out guard
- **File:** backend/src/modules/inventory/inventory.service.ts
- **Line:** 56-61, 83-87
- **Problem:** `listItems` and `recordMovement`'s OUT-quantity guard each independently compute `COALESCE(SUM(CASE WHEN entry_type='IN' THEN quantity ELSE -quantity END),0)`. A future change to the stock formula (e.g. per-warehouse filtering) risks only being applied to one call site.
- **Severity:** Medium
- **Recommended Fix:** Extract a single `currentStockQty(companyId, itemId?)` helper and reuse it in both places.

### "Today as YYYY-MM-DD" computed inline in four places
- **File:** backend/src/modules/reports/reports.controller.ts
- **Line:** 8, 34
- **Problem:** `new Date().toISOString().slice(0, 10)` is repeated verbatim here and in `backend/src/modules/dashboard/dashboard.service.ts:13` and `backend/src/modules/bookings/bookings.service.ts:136,215`.
- **Severity:** Low
- **Recommended Fix:** Add a `today()` helper (e.g. `utils/date.ts`) and use it at all call sites.

### VAT/discount/total tax calculation reimplemented in two unrelated forms
- **File:** frontend/src/pages/bookings/Bookings.tsx
- **Line:** 200-203
- **Problem:** `ConfirmModal` computes `taxable = Math.max(0, sale - discount)`, `vat = Math.round(taxable * vatPercent) / 100`, `total = Math.round((taxable + vat) * 100) / 100`. The identical formula is independently reimplemented in `frontend/src/pages/invoices/Invoices.tsx:161-166` (`ManualInvoiceModal`'s `totals`), just fed from line items instead of a single price. Both hardcode a default VAT of `'5'`.
- **Severity:** High
- **Recommended Fix:** Extract a shared `calcTax(base, discount, vatPercent)` helper and use it in both places.

### PDF brand palette and currency formatter duplicated across the two PDF renderers
- **File:** backend/src/modules/invoices/invoice.pdf.ts
- **Line:** 5-11
- **Problem:** `const TEAL = '#0f766e'; const INK = '#111827'; const MUTED = '#6b7280';` and the `bdt()` currency formatter are defined identically in both `invoice.pdf.ts` and `backend/src/modules/hr/payslip.pdf.ts:5-10`. A brand-color or currency-format change requires editing both files in lockstep.
- **Severity:** Medium
- **Recommended Fix:** Extract a shared `pdf/theme.ts` (colors) and reuse `bdt()` from `utils/money.ts` (or a new shared formatter) in both renderers. See also §19.

### Role-based UI gating hardcoded and duplicated across every page module
- **File:** frontend/src/pages/bookings/Bookings.tsx
- **Line:** 25-26
- **Problem:** Every page independently hardcodes its own role arrays to gate UI actions: `Bookings.tsx:25-26`, `Crm.tsx:40-41`, `Hr.tsx:33-35` (three separate lists), `Inventory.tsx:26-27`, `Invoices.tsx:24`, `Payments.tsx:20`, `Accounting.tsx:41` (written as an `===` OR-chain, inconsistent with the rest), `DatabaseAdmin.tsx:58`, and `AppShell.tsx:56` (`roles: ['ADMIN']`). There is no single source of truth for "who can do what" on the frontend — a permission change requires editing 8+ files and can silently drift from the backend's actual RBAC rules.
- **Severity:** High
- **Recommended Fix:** Centralize into a shared `frontend/src/lib/roles.ts` (constants + a `usePermissions()`/`canWrite()` helper) and update all pages plus `AppShell.tsx` to consume it. See also §16.

## 8. Dead code

### `crmService.outstanding` is exported but never called
- **File:** backend/src/modules/crm/crm.service.ts
- **Line:** 90
- **Problem:** `outstanding: (companyId) => reportsService.customerOutstanding(companyId)` is a passthrough that nothing imports or routes to.
- **Severity:** Low
- **Recommended Fix:** Remove it, or wire it to a route and use it to fix the §17/§4 duplication instead of the ad hoc inline query.

### Empty `frontend/src/components/ui/` directory alongside `components/ui.tsx`
- **File:** frontend/src/components/ui/
- **Line:** N/A (empty directory)
- **Problem:** An empty directory sits next to the real shared-UI module `components/ui.tsx`. Nothing imports from it — likely leftover scaffolding from an abandoned refactor.
- **Severity:** Low
- **Recommended Fix:** Delete the empty directory.

## 9. Unused imports
No compiler enforcement exists for this today: `frontend/tsconfig.json:15-16` explicitly sets `"noUnusedLocals": false` and `"noUnusedParameters": false`, and `backend/tsconfig.json` doesn't set them either (default off). Manually eyeballing every import across ~90 source files for zero-confidence "might be unused" isn't reliable without compiler help, so no individual unused-import findings are claimed here.
- **Severity:** Low (process gap, not a specific bug)
- **Recommended Fix:** Enable `"noUnusedLocals": true` and `"noUnusedParameters": true` in both `backend/tsconfig.json` and `frontend/tsconfig.json`, then fix what the compiler flags. This turns an unverifiable manual sweep into an enforced, repeatable check.

## 10. Unused files

### 17 leftover debugging screenshots sitting in the repo root
- **File:** `dbeaver-*.png` (11 files: window, current, after-expand, expanded2, db-expanded, tripfly-selected, tripfly-expanded, tables-expanded, customers-open, customers-data, after-ctrlpgdn, after-wait) and `screen-*.png` (6 files: current, data-tab, after-shortcut, after-doubleclick, filter-customers, customers-data-final)
- **Line:** N/A
- **Problem:** These are DBeaver/screen-capture artifacts from earlier manual database exploration, untracked in git, sitting at the repo root — not referenced by any application code, docs, or build step.
- **Severity:** Low
- **Recommended Fix:** Delete them (or move to a `.gitignore`d scratch folder if they're still needed for reference).

(Empty `components/ui/` directory — see §8, same root cause.)

## 11. Orphaned database tables
None found. Every table in `schema.sql` is actively queried by at least one backend module (verified via targeted grep for `FROM/INTO/UPDATE <table>` across `backend/src`).

## 12. Inconsistent naming

### Accounting routes break the `/api/<module>` convention
- **File:** backend/src/app.ts
- **Line:** 51 (after the recent reorder for the company-settings public-route fix)
- **Problem:** Every other module mounts at `/api/<module-name>`, but `accountingRoutes` mounts at the bare `/api`, so its endpoints live at `/api/ledgers`, `/api/ledger-groups`, `/api/vouchers` instead of `/api/accounting/...`. Called out in a code comment but still a real deviation from the pattern every other module follows.
- **Severity:** Low
- **Recommended Fix:** Mount at `/api/accounting` for consistency (requires updating frontend call sites), or explicitly document the exception if the flat URLs are frozen for compatibility reasons.

### Voucher-type list redefined three times in one feature
- **File:** backend/src/modules/accounting/accounting.controller.ts
- **Line:** 15, 80
- **Problem:** The literal list `['JOURNAL','PAYMENT','RECEIPT','SALES','PURCHASE','CONTRA','DEBIT_NOTE','CREDIT_NOTE']` is written out as a zod enum twice in this file, and again as a TS union in `accounting.service.ts:9`. Any new voucher type needs three manual edits kept in sync by hand.
- **Severity:** Medium
- **Recommended Fix:** Define one `VOUCHER_TYPES` const array; derive the zod enum and the TS union type from it.

### Tab-config naming convention differs between otherwise-identical pages
- **File:** frontend/src/pages/reports/Reports.tsx
- **Line:** 9
- **Problem:** `Reports.tsx` names its tab config `TABS` (uppercase module constant), while the same concept is a local lowercase `tabs` in `Accounting.tsx:55`, `Crm.tsx:77-80`, `Hr.tsx:38`, and `Inventory.tsx:43`.
- **Severity:** Low
- **Recommended Fix:** Standardize once the tab bar is extracted into the shared `TabBar` component (§3).

## 13. Hardcoded company information

### Demo inventory item description references the company name
- **File:** database/seed.sql
- **Line:** 113
- **Problem:** `'Trip Fly BD co-branded hard luggage tag'` — a product description for demo data, not application branding. Low-risk since it's seed data describing a fictional SKU, not a UI/PDF branding string.
- **Severity:** Low
- **Recommended Fix:** Optional — reword to a generic description if the seed data should be fully company-agnostic.

### Example deployment domain hardcoded in docs instead of using a placeholder
- **File:** README.md
- **Line:** 113, 135
- **Problem:** `CORS_ORIGIN=https://erp.tripflybd.com,...` and a reference to adding `erp.tripflybd.com` as the custom domain — real project domain baked into setup instructions, inconsistent with the placeholder style used right next to it (`<frontend-service>.up.railway.app`).
- **Severity:** Low
- **Recommended Fix:** Replace with a placeholder like `<your-domain>` for consistency with the rest of the deployment doc.

(All application source code — backend and frontend — is clean of hardcoded company branding; verified by repo-wide search. The only remaining `Trip Fly BD` / `tripflybd.com` references in `.ts`/`.tsx` files are the demo login email addresses in `Login.tsx`, `seed.sql`, and `auth.controller.ts`'s JSDoc example, which were explicitly decided to keep as functional demo credentials in an earlier round of this work.)

## 14. Hardcoded logo paths
None found. Logo/favicon rendering correctly flows through `company.logo_url` / `resolveAssetUrl()` everywhere it's used (`AppShell.tsx`, `Login.tsx`, `App.tsx`'s `DocumentBranding`).

## 15. Hardcoded URLs
None found in application logic. The only URL-shaped literals are `env.ts`'s documented `localhost` dev-only CORS fallback and a form `placeholder="https://example.com"` attribute (UI hint text, not a real endpoint) — both are expected and correctly scoped.

## 16. Hardcoded role names

### `optionalIdSchema` exists but role/ID validation is still duplicated (see §19 for the ID case)
Cross-reference: the dominant hardcoded-role-names issue is the frontend UI-gating duplication already detailed in full under §7 (`Bookings.tsx:25-26` and 8 other files) — role literals `'ADMIN'`/`'ACCOUNTANT'`/`'SALES'`/`'MANAGER'` are re-typed in every page instead of coming from one shared source, unlike the backend where `rbac.ts`'s `RoleName` type is the single definition consumed via `allow(...)` everywhere.
- **Severity:** High (see §7 for full file list and fix)

## 17. Duplicate SQL queries

### Customer outstanding-balance query duplicated between CRM and Reports, with diverging results
- **File:** backend/src/modules/crm/crm.service.ts
- **Line:** 16-25
- **Problem:** `listCustomers` inlines the exact same outstanding-balance SQL that already exists as `reportsService.customerOutstanding` (`backend/src/modules/reports/reports.service.ts:130-142`) — but the two copies have drifted: `reports.service.ts` filters with `HAVING outstanding <> 0`, `crm.service.ts` does not. The same concept returns different rows depending on which endpoint is called. (`crmService.outstanding`, §8, already correctly delegates to the reports version but is unused.)
- **Severity:** High
- **Recommended Fix:** Have `listCustomers` reuse `reportsService.customerOutstanding` (or extract the shared expression into one function).

(Party/customer/supplier lookup duplication and stock-quantity duplication — see §7 for full detail, same underlying issue.)

## 18. Duplicate PDF templates

### `invoice.pdf.ts` and `payslip.pdf.ts` share an un-shared color palette and currency formatter
- **File:** backend/src/modules/invoices/invoice.pdf.ts
- **Line:** 5-11 (compare `backend/src/modules/hr/payslip.pdf.ts:5-10`)
- **Problem:** Both PDF renderers independently define identical `TEAL`/`INK`/`MUTED` brand colors and an identical `bdt()` currency formatter, plus a structurally similar "brand band" header layout (company name band → detail rows → footer). No shared PDF theme/layout module exists between them.
- **Severity:** Medium
- **Recommended Fix:** Extract shared color constants and the currency formatter into one module (e.g. `backend/src/modules/pdf/theme.ts`); consider a shared `renderBrandBand(doc, company, title)` helper for the header both files currently hand-roll separately.

## 19. Duplicate validation logic

### `optionalIdSchema` defined in `utils/validation.ts` but never imported — reimplemented inline instead
- **File:** backend/src/utils/validation.ts
- **Line:** 5
- **Problem:** `optionalIdSchema = z.coerce.number().int().positive().optional()` is exported but unused. The identical zod expression is hand-written at `backend/src/modules/bookings/bookings.controller.ts:38` and `backend/src/modules/inventory/inventory.controller.ts:53`.
- **Severity:** Medium
- **Recommended Fix:** Replace both inline expressions with the existing `optionalIdSchema` import.

(Voucher-type enum tripled — see §12. VAT/tax calculation duplicated on the frontend — see §7, High severity, the most impactful item in this category.)

## 20. (Additional finding surfaced during the audit, outside the 20 requested categories)

### Cross-tenant data leak in the dashboard "Recent Activity" feed
- **File:** backend/src/modules/dashboard/dashboard.service.ts
- **Line:** 103-109
- **Problem:** `recentActivity` queries `WHERE u.company_id = ? OR a.user_id IS NULL`. `audit()` (`backend/src/middleware/audit.ts:11`) writes `user_id: req.user?.sub ?? null`, and `POST /api/auth/login` (unauthenticated — no `authenticate` middleware) calls `audit(req, 'LOGIN', 'users', data.user.id)` before `req.user` exists, so every `LOGIN` audit row is written with `user_id = NULL`. Verified this is the only unauthenticated `audit()` call site in the codebase (all 19 other call sites are behind `router.use(authenticate)`). Because of the `OR a.user_id IS NULL` clause, every company's "Recent Activity" panel shows **every company's** login events, not just its own — a multi-tenant isolation violation, though limited in blast radius to login timestamps + internal user IDs (no passwords, financial, or other business data leaks this way).
- **Severity:** High
- **Recommended Fix:** Store `company_id` directly on `audit_logs` at write time (resolve it from the login result before calling `audit()`, or add a `companyId` param to the `audit()` helper), and change the query to `WHERE a.company_id = ?` — dropping the `OR a.user_id IS NULL` fallback entirely.

---

## Summary

| Severity | Count |
|---|---|
| High | 5 |
| Medium | 7 |
| Low | 9 |

(Counts are of unique findings — a few items are cross-referenced from more than one of the 20 requested categories since they genuinely span more than one, e.g. the role-gating duplication shows up under both §7 and §16.)

No fixes have been applied. Waiting for approval on which items to act on before making any changes.
