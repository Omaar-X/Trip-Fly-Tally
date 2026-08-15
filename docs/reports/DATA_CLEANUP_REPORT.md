# Data Cleanup Report — Production-Ready Empty Baseline

**Date:** 2026-07-30
**Scope:** `database/seed.sql` rewritten from scratch; local dev database reset to match.

## Deleted records

`database/seed.sql` previously seeded a full demo travel agency ("Trip Fly BD"). All of the following record types are now **gone from seed data entirely** — the counts below are what was in the local dev database immediately before this cleanup (some accumulated from earlier feature testing in this session, on top of the original demo seed):

| Table | Rows removed | What it was |
|---|---|---|
| `companies` (real data) | 1 real profile | Real company branding entered earlier via the setup wizard — reset back to the blank placeholder template. |
| `customers` | 3 | Demo customers (Tanvir Ahmed, GreenTex Apparels, Maliha Begum). |
| `suppliers` | 2 | Demo vendors (Biman Bangladesh Airlines, Sea Pearl Beach Resort). |
| `warehouses` | 2 | Demo stock locations. |
| `items` | 5 | Demo inventory SKUs (SIM card, luggage tag, etc.). |
| `stock_entries` | 13 | Demo stock IN/OUT movements. |
| `employees` | 5 (+1 from testing) | Demo staff records. |
| `attendance` | 20 | Demo attendance marks. |
| `payroll_runs` / `payslips` | 1 / 5 (+1/1 from testing) | Demo and test-generated payroll. |
| `vouchers` / `voucher_entries` | 5 / 10 (+2/2 from testing) | Demo accounting transactions (rent payment, marketing expense, sales, receipts) plus test vouchers from payroll approval testing. |
| `invoices` / `invoice_items` | 2 / 2 | Demo invoices. |
| `bookings` | 4 | Demo flight/hotel/tour bookings. |
| `payments` | 1 | Demo customer receipt. |
| `users` (non-bootstrap) | all 4 old demo accounts + 1 test account created during regression testing | `admin@tripflybd.com`, `accountant@tripflybd.com`, `sales@tripflybd.com`, `manager@tripflybd.com`, and a `newtest2@example.com` test account — replaced by the 5 new bootstrap accounts (see below). |
| `roles` | 4 old roles replaced | `ADMIN`/`ACCOUNTANT`/`SALES`/`MANAGER` replaced by the new 5-role set — see `ROLE_MIGRATION_REPORT.md`. |
| `audit_logs`, `refresh_tokens` | all rows | Session/activity history from demo and testing logins — cleared as part of resetting to a genuinely fresh baseline (these regenerate naturally from real usage). |
| Non-system expense ledgers (`Office Rent`, `Utilities`, `Marketing & Ads`) | 3 | Example expense ledgers that weren't required by the accounting engine (`SYSTEM_LEDGERS`) — dropped as unnecessary demo scaffolding. |
| Demo customer/supplier sub-ledgers | 5 | Auto-created ledgers tied to the deleted demo customers/suppliers. |

## Remaining records (in `database/seed.sql`, applied to the local dev DB)

| Table | Rows | Why it remains |
|---|---|---|
| `companies` | 1 | **Required scaffolding, not real data.** `users.company_id` has a `NOT NULL` foreign key — a login account cannot exist without a company row to point at. This row is a blank placeholder (`name = 'My Company'`, `is_configured = 0`) that forces the CEO into the Company Setup Wizard on first login rather than exposing a real business identity. |
| `roles` | 5 | The RBAC catalogue itself — `CEO`, `ADMIN`, `ACCOUNTANT`, `SALES`, `HR`. Not "data" in the demo sense; this is structural configuration every login depends on. |
| `users` | 5 | One bootstrap login per role, since there is no self-service "first admin" signup flow anywhere in the app (verified — the only way to create a user is an already-authenticated CEO calling `POST /api/auth/register`). Without at least one seeded account, the system could never be logged into at all. **These are meant to be rotated/replaced immediately in a real deployment** — see credentials below. |
| `ledger_groups` | 16 | The chart-of-accounts *tree structure* (Assets → Current Assets → Cash-in-Hand, etc.) — structural, not transactional. Referenced by name (`findGroupId`) when the app auto-creates a sub-ledger for a new customer/supplier. |
| `ledgers` | 11 | The chart-of-accounts *system ledgers* (Cash in Hand, Bank, VAT Payable, Salary Expense, etc.) — required because `backend/src/utils/systemLedgers.ts`'s `findLedgerId()` looks these up **by exact name** when posting any voucher (a payment, a booking confirmation, a payroll run). Without them, the very first payment or booking confirmation in a fresh deployment would fail with "Required system ledger not found." **All opening balances are 0.00** — this is a template, not a funded company. |

Every other table (`customers`, `suppliers`, `warehouses`, `items`, `stock_entries`, `bookings`, `invoices`, `invoice_items`, `payments`, `employees`, `attendance`, `payroll_runs`, `payslips`, `vouchers`, `voucher_entries`, `audit_logs`, `refresh_tokens`) is **empty** — 0 rows — confirmed by direct query against the freshly-seeded local database.

## Bootstrap credentials

| Role | Email | Password |
|---|---|---|
| CEO | Configured securely in deployment environment | Not documented or committed |
| Other roles | Self-registration | CEO approval required |

Other roles use the registration form and remain pending until the CEO approves them.

## First-login behavior confirmed

Logged in as the configured CEO account against the fresh baseline: redirected straight to the Company Setup Wizard (`is_configured = 0`), which requires the CEO to enter the real company name, address, phone, email, website, tax numbers, and upload a logo before the rest of the app becomes usable.

## An unrelated bug found and fixed during this cleanup

Applying the rewritten `seed.sql` via `mysql ... < seed.sql` **without** `--default-character-set=utf8mb4` silently corrupted the em-dash in `'City Bank — A/C 110245'`, which broke payroll disbursement (`findLedgerId` couldn't find the mangled name). This is an environment/tooling pitfall, not a bug in the seed data — re-applying with the correct flag fixed it immediately. Added a note + the flag to `README.md`'s setup commands so it doesn't bite a future deployer the same way.

## Verification

- Fresh `schema.sql` + `seed.sql` applied to the local dev database (with the corrected charset flag).
- Direct row-count query confirms: `companies=1`, `roles=5`, `users=5`, `ledger_groups=16`, `ledgers=11`, and **every other table = 0**.
- All 5 bootstrap accounts log in successfully.
- Full regression suite (22 permission checks + the end-to-end payroll approval workflow) run against this exact baseline — see `ROLE_MIGRATION_REPORT.md` — then the database was reset one final time to the pristine state described above (no leftover test data).
