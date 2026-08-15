# Admin Database Multi-Tenant Isolation — Security Report

**Date:** 2026-07-29
**Scope:** `backend/src/modules/adminDatabase/` — the generic table browser/CSV export/full-backup tool reachable at `/api/admin/database/*`.

## Root Cause

`adminDatabaseService.tableData`, `tableCsv`, and `fullBackup` ran `SELECT * FROM <table>` (or `COUNT(*)`) with **no `company_id` filtering at all**. `ADMIN` in this app is a company-scoped role (every ADMIN belongs to exactly one `company_id`, same as every other role — there is no separate platform-superadmin concept), so any company's ADMIN could browse, CSV-export, or full-backup-export **every other company's raw data** — customers, invoices, payments, employees, vouchers, everything — through an endpoint whose route is only gated by `authenticate + allow('ADMIN')` ([adminDatabase.routes.ts:8](backend/src/modules/adminDatabase/adminDatabase.routes.ts:8)), not by tenant.

This is a strictly worse instance of the same bug class fixed in Issue #1 (dashboard activity leak) — there, one query leaked one feed; here, the entire database was reachable unfiltered through three endpoints at once.

## Design

Every one of the 22 tables in `database/schema.sql` is classified into exactly one bucket by `classifyTable()` in `adminDatabase.service.ts`:

| Scope | Meaning | Tables |
|---|---|---|
| **root** | The tenant itself — filtered by its own `id`, not a `company_id` column | `companies` |
| **tenant** | Has a direct `company_id` column — filtered on it | `users`, `ledger_groups`, `ledgers`, `vouchers`, `customers`, `suppliers`, `warehouses`, `items`, `stock_entries`, `bookings`, `invoices`, `payments`, `employees`, `payroll_runs` (14 tables) |
| **system** | Genuinely shared, non-tenant reference data — safe to show in full | `roles` |
| **joined** | No `company_id` column of its own, but every row is reachable via exactly one well-defined FK to a parent table that has `company_id` | `voucher_entries`, `invoice_items`, `attendance`, `payslips`, `audit_logs`, `refresh_tokens` (6 tables) |
| **blocked** | No `company_id` column AND no safe single-hop FK to a scoped parent | none currently — reserved as the fail-closed default for any table not explicitly classified above (including ones added to the schema later without updating this file) |

Any table not explicitly listed in one of the four known buckets falls into **blocked** by default — the classifier fails closed, not open. This means the six join-filtered tables below only exist because each one was individually checked against `schema.sql` and found to have a genuinely safe, unambiguous join — not because the default became permissive.

## Files Changed

- **`backend/src/modules/adminDatabase/adminDatabase.service.ts`** — table classification, plus `scopedQuery(table, companyId, safeTable)` which builds the right `FROM ... [JOIN ...] WHERE ...` fragment for whichever scope kind applies (base table always aliased `t`, so `tableData`/`tableCsv`/`fullBackup` all project `t.*` uniformly). `tableData`, `tableCsv`, and `fullBackup` take `companyId` and use it.
- **`backend/src/modules/adminDatabase/adminDatabase.controller.ts`** — `tableData`, `tableCsv`, `fullBackup` pass `req.user!.companyId` (from the verified JWT) into the service calls.

No schema change. No route/RBAC change (`authenticate + allow('ADMIN')` was already correct — the bug was in the service layer).

## Security Impact

**Before any fix:** any company's ADMIN could read, CSV-export, or full-JSON-export every other company's business data across all 22 tables with zero cross-tenant restriction.

**After:** every tenant table is filtered to the caller's own `company_id` (directly or via a verified join); `companies` is filtered to the caller's own row; `roles` (genuinely shared) is unaffected; any table that can't be safely scoped is blocked outright rather than guessed at.

---

## Update — Table Ownership Resolution (Issue #1.5)

The initial fix blocked 6 tables outright because they have no `company_id` column. Each was re-examined against `schema.sql` to see whether a safe, single-hop join to a company-scoped parent exists.

### Tables now JOIN-filtered (moved from blocked → joined)

| Table | Join | Why it's safe |
|---|---|---|
| `voucher_entries` | `JOIN vouchers p ON p.id = t.voucher_id` | `voucher_id` is `NOT NULL` — every row has exactly one determinable owner. |
| `invoice_items` | `JOIN invoices p ON p.id = t.invoice_id` | `invoice_id` is `NOT NULL` — same. |
| `attendance` | `JOIN employees p ON p.id = t.employee_id` | `employee_id` is `NOT NULL` — same. |
| `payslips` | `JOIN payroll_runs p ON p.id = t.payroll_run_id` | `payroll_run_id` is `NOT NULL`. (`employee_id` is also a valid, always-same-company alternative — `payroll_run_id` was chosen since "which company's payroll run" is the more direct question for this table.) |
| `refresh_tokens` | `JOIN users p ON p.id = t.user_id` | `user_id` is `NOT NULL`. Note: this table only ever stores a SHA-256 hash of the token (`token_hash`), never the raw token — exposing scoped rows here reveals session metadata (which user, when, revoked or not), not anything that can be used to forge a session. |
| `audit_logs` | `JOIN users p ON p.id = t.user_id` (INNER JOIN) | `user_id` is **nullable** (set NULL if a user is ever deleted, or historically if written before an unauthenticated action — see Issue #1). The `INNER JOIN` (not `LEFT JOIN`) is the important detail: rows with a determinable owner are correctly scoped to that owner; rows with `user_id = NULL` have no determinable owner and are correctly **excluded from every company's view**, not guessed into one. This is the same principle as blocking a whole table, just applied per-row instead of per-table. |

### Tables still blocked

**None**, as of this table's known schema — all 6 previously-blocked tables had a safe single-hop join available. The `blocked` classification still exists in the code and is exercised by the fail-closed default: any table not explicitly listed as root/system/tenant/joined (e.g. a new table added later without updating `adminDatabase.service.ts`) is denied by default rather than exposed.

## Tests Performed (this update)

1. `tsc --noEmit` (backend) — clean. `tsc -b && vite build` (frontend) — clean, no frontend changes needed.
2. **Two real companies again** (Company A = seeded "Trip Fly BD"; a temporary Company B with its own ADMIN, login session, and one marker row inserted into every one of the 6 newly-joined tables: a voucher + `voucher_entries` row, an invoice + `invoice_items` row, an employee + `attendance` row, a `payroll_runs` + `payslips` row, plus the `refresh_tokens`/`audit_logs` rows naturally created by Company B's admin logging in):
   - `voucher_entries`: A saw its own 10 rows, B saw exactly its 1 (`ONLY-B-VOUCHER-ENTRY`).
   - `invoice_items`: A saw its own 2, B saw exactly its 1 (`ONLY-B-INVOICE-ITEM`).
   - `attendance`: A saw its own 20, B saw exactly its 1.
   - `payslips`: A saw 0 (none currently exist for A), B saw exactly its 1.
   - `refresh_tokens`: A saw its own 11 (all `user_id = 1`), B saw exactly its 1 (`user_id = 100`).
   - `audit_logs`: A saw its own 11 events, B saw exactly its 1 (`LOGIN`).
   - CSV export of `voucher_entries` as B returned exactly the one B row.
   - `fullBackup`'s `skipped` array is now `[]` — all 22 tables are included, each correctly scoped; verified B's export contained only its own `attendance`/`payslips` rows.
   - Regression: `companies` (root), `customers` (tenant), `roles` (system) all still scope correctly as before.
3. Deleted all Company B test data afterward (in FK-safe order: `payslips` → `payroll_runs` → `attendance` → `employees` → `invoice_items` → `invoices` → `customers` → `voucher_entries` → `vouchers` → `ledgers` → `ledger_groups` → `refresh_tokens` → `audit_logs` → `users` → `companies`). Verified row counts back to the original seeded baseline (1 company, 4 users, 3 customers, 10 voucher_entries, 2 invoice_items, 20 attendance rows).

## Remaining Limitations

- **No table is currently blocked** — every table in the current schema has a safe scoping path. The `blocked` bucket is dormant but load-bearing: it's what a future table falls into by default if `adminDatabase.service.ts` isn't updated when the schema changes. This is a manual-maintenance dependency worth knowing about, not a bug.
- **`fullBackup` is a company-scoped data export, not a true full database backup.** Same as noted in the original fix — for disaster-recovery-grade full backups, that needs to be a separate, infrastructure-level operation (e.g. `mysqldump` run by an operator), not an application API gated by a tenant-scoped role.
- **`audit_logs` rows with a `NULL` `user_id`** (e.g. from a hypothetical future user-deletion feature) are now invisible to every company via this tool, not just excluded from cross-tenant leakage — this is the correct trade-off (no determinable owner means no one should see it here), but it does mean such rows aren't recoverable through this tool if that's ever needed; they'd need a direct DB query by someone with infrastructure access.
- **`tables()` (the table-list endpoint) still returns global row counts and sizes** from `information_schema` for every table — unchanged from the original fix, still judged out of scope (it's DB-wide schema metadata, not a company_id-scoped query).
