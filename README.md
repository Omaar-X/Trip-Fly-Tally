# TRIP FLY BD — Travel Agency ERP

A full-stack, production-grade ERP for a travel agency, built around a **Tally-style double-entry accounting core**. Every business action — confirming a booking, receiving a payment, paying salaries — posts balanced vouchers into one ledger of truth.

| Layer | Stack |
|---|---|
| Backend | Node.js · Express · TypeScript (Clean Architecture: routes → controllers → services → repositories) |
| Frontend | React 18 · TypeScript · TailwindCSS · Recharts (Zoho Books × Tally hybrid UI, dark/light, fully responsive) |
| Database | MySQL 8 (InnoDB, FK-enforced) |
| Auth | JWT access + rotating refresh tokens · RBAC (`CEO`, `ADMIN`, `ACCOUNTANT`, `SALES`, `HR`) via one central permission config · audit logging |
| PDFs | pdfkit — print-ready tax invoices & payslips |

## The accounting core

Five rules are enforced in one place — `postVoucherTx` — so every module that
touches money obeys them identically:

1. Every voucher carries at least one debit and one credit.
2. Every line is strictly positive.
3. `SUM(debits) == SUM(credits)`, compared in integer paisa.
4. Every ledger named belongs to the posting company.
5. The date sits inside an **open, already-begun, non-future** period.

**Financial year and period lock.** The books have a start (`books_begin_from`)
and a lockable past (`books_locked_upto`). Opening balances express the
position on the day before the books begin; the FY start month is configurable
and defaults to July, Bangladesh's year. Once a year is filed the CEO locks it,
and corrections after that must be posted in the open period as reversals —
which is what keeps a printed Balance Sheet true.

**Correction, never edit.** No voucher is ever edited or deleted. Reversing one
posts a mirrored voucher linked to the original in both directions, so the
audit trail keeps the mistake *and* its correction. Vouchers owned by a
document (invoice, payment, payroll run, stock movement) are refused by the
generic reversal endpoint and must be unwound through that document, so the
ledger and the document can never disagree.

**Numbering.** Documents are numbered per company, per kind, per financial
year, from an atomic counter — `SV-2026-2027-00014`. The year comes from the
document's own date, and sequences restart each financial year.

## Modules

- **Accounting** — chart of accounts, all 8 voucher types (Journal, Payment, Receipt, Sales, Purchase, Contra, Debit/Credit Note), ledger statements whose opening balance carries forward from every prior voucher, and one-click reversal of any free-standing voucher.
- **Reports** — Trial Balance (opening · movement · closing, Tally-style), Profit & Loss, Balance Sheet, Cash Book, Bank Book, Day Book, daily sales, customer outstanding — all computed live from vouchers, and all defaulting to the current financial year. An unbalanced set of opening balances is surfaced as **Difference in Opening Balances** rather than quietly absorbed.
- **Travel Bookings** — flight / hotel / tour. Confirming a booking posts the sales voucher, raises the VAT invoice, and books supplier cost in a single transaction. Cancelling reverses *both* the sales and the supplier-cost voucher and voids the invoice; money already collected must be refunded first.
- **Invoicing** — auto (from bookings) and manual invoices, discounts, Bangladesh VAT, partial payments, status tracking, branded PDF.
- **Payments** — every money movement through one generic counterparty model: customer receipts, **customer refunds**, supplier payments and supplier credits. Each channel (Cash / Bank / bKash / Nagad / Card) posts to **its own ledger**, so every one can be reconciled against its real statement. Optional invoice settlement rolls forward on receipts and back on refunds; overpayment, over-refund and phantom supplier credits are all rejected. A payment recorded in error is reversed with the invoice's collected figure corrected in the same transaction.
- **Inventory** — items, full warehouse CRUD, and IN/OUT movements that **post to the ledger**: a receipt is `Dr Stock in Hand / Cr Supplier A/P`, an issue is `Dr Cost of Goods Sold / Cr Stock in Hand` at weighted-average cost. Closing stock therefore appears on the Balance Sheet and cost of goods in the P&L. Stock is checked per warehouse inside the transaction, and valuation is shown under **FIFO and weighted average side by side**.
- **CRM** — customers and suppliers each get an auto-created sub-ledger; live receivable/payable balances; customer 360° profile (bookings, invoices, payments).
- **HR & Payroll** — employees, salary engine (`basic + allowances + commission − deduction`, where commission is a share of the margin on bookings *invoiced* in the period), DRAFT → APPROVED → PAID workflow that accrues on the **last day of the payroll month** rather than the day someone clicks approve. An approved run can be un-approved, reversing the accrual.

  **Attendance is not part of this system.** It is kept separately, so payroll does not derive an absence deduction — deriving one from working days and present days it cannot see would produce a number that looks authoritative and is not. Instead the deduction is entered per employee as a taka figure when the run is generated, computed wherever attendance actually lives. See [`database/migrations/004_remove_attendance.sql`](./database/migrations/004_remove_attendance.sql).
- **Dashboard** — YTD revenue/expense/profit straight from the ledger, 12-month trend, revenue by service, cash & bank position, activity feed.

## Prerequisites

- Node.js **18+**
- MySQL **8.x**

## 1 — Database

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS erp_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
# --default-character-set=utf8mb4 matters: some client/shell combinations (seen
# on Windows) silently mangle the em-dash in ledger names without it, which
# breaks system-ledger lookups by exact name (e.g. "City Bank — A/C 110245").
mysql -u root -p --default-character-set=utf8mb4 erp_db < database/schema.sql   # creates tables in selected DB
mysql -u root -p --default-character-set=utf8mb4 erp_db < database/seed.sql     # roles, bootstrap users, default chart of accounts — empty, no demo data
# `erp_db` is just the default DB_NAME in .env.example — rename freely as long
# as your .env's DB_NAME (or DATABASE_URL) matches what you create here.
```

**Upgrading an existing database?** `schema.sql` drops and recreates tables, so
never re-run it against live data. Apply the additive migrations instead:

```bash
mysql -u root -p --default-character-set=utf8mb4 erp_db < database/migrations/001_company_settings.sql
mysql -u root -p --default-character-set=utf8mb4 erp_db < database/migrations/002_voucher_reversal_and_refunds.sql
mysql -u root -p --default-character-set=utf8mb4 erp_db < database/migrations/003_tally_parity.sql
mysql -u root -p --default-character-set=utf8mb4 erp_db < database/migrations/004_remove_attendance.sql
```

Migration 002 adds voucher reversal, customer refunds and warehouse seeding —
see [`docs/ACCOUNTING_WORKFLOW_FIXES.md`](./docs/ACCOUNTING_WORKFLOW_FIXES.md),
which also explains how to find bookings cancelled *before* the fix that still
carry an orphaned supplier payable.

Migration 003 adds the financial year and period lock, per-FY document
numbering, the ledger link on stock movements, and the separate Nagad, card
settlement and inventory control ledgers. It is additive and safe to re-run.

Migration 004 removes the attendance module: it **drops the `attendance` table**
and replaces the attendance-derived payslip columns with a single `deduction`.
Existing absence deductions are folded into it first, so no payslip's net pay
changes. Back up `attendance` first if that data matters to you.

## 2 — Backend (port 4000)

```bash
cd backend
cp .env.example .env       # set DB_USER / DB_PASSWORD for your MySQL
npm install
npm run dev                # http://localhost:4000  (liveness: GET /api/health, readiness: GET /api/ready)
```

## 3 — Frontend (port 5173)

```bash
cd frontend
npm install
npm run dev                # http://localhost:5173  (dev proxy → :4000)
```

## Login and registration

| Role | Email | Password |
|---|---|---|
| CEO | Configured securely in the deployment environment | Not documented or committed |
| Other roles | Self-registration | CEO approval required |

The database seeds only the CEO account, system roles, chart of accounts, warehouse and a blank company placeholder. Other roles register from the login screen and require CEO approval. The CEO completes real setup (company profile, financial year, logo) via the Company Setup Wizard shown on first login.

## API at a glance

All endpoints are under `/api`, return `{ "success": true, "data": … }`, and (except auth) require `Authorization: Bearer <accessToken>`.

```http
POST /api/auth/login              { "email": "<ceo-email>", "password": "<secret>" }
POST /api/auth/refresh            { "refreshToken": "…" }            # rotating refresh
GET  /api/ledgers                                                    # chart of accounts + balances
POST /api/vouchers                { "type": "JOURNAL", "date": "2026-06-10",
                                    "entries": [ { "ledgerId": 1, "type": "DR", "amount": 5000 },
                                                 { "ledgerId": 4, "type": "CR", "amount": 5000 } ] }
GET  /api/reports/profit-loss?from=2026-01-01&to=2026-06-30
GET  /api/reports/trial-balance?from=2026-01-01&to=2026-06-30
POST /api/bookings                { "customerId": 1, "bookingType": "FLIGHT",
                                    "costPrice": 50000, "salePrice": 56500, "supplierId": 1 }
POST /api/vouchers/:id/reverse    { "reason": "Posted to the wrong ledger" }   # mirrored reversal
PUT  /api/company-settings/period-lock  { "booksLockedUpto": "2026-06-30" }    # close the year (CEO)
POST /api/bookings/:id/confirm    { "vatPercent": 5, "discount": 0,
                                    "invoiceDate": "2026-06-28", "dueDate": "2026-06-30" }
POST /api/bookings/:id/cancel     { "reason": "Customer cancelled" }   # reverses BOTH vouchers
POST /api/payments                { "direction": "IN", "counterpartyType": "CUSTOMER", "counterpartyId": 1,
                                    "invoiceId": 3, "method": "BKASH", "amount": 20000,
                                    "paymentDate": "2026-06-10" }
POST /api/payments                { "direction": "OUT", "counterpartyType": "CUSTOMER", "counterpartyId": 1,
                                    "invoiceId": 3, "method": "BKASH", "amount": 20000,
                                    "paymentDate": "2026-06-12", "reason": "Trip cancelled" }   # refund
POST /api/payments/:id/reverse    { "reason": "Wrong customer" }      # ledger + invoice together
POST /api/inventory/warehouses    { "name": "Main Warehouse", "location": "Dhaka" }
POST /api/inventory/movements     { "itemId": 1, "warehouseId": 1, "type": "IN", "quantity": 50,
                                    "rate": 270, "date": "2026-06-10", "supplierId": 3 }  # posts a voucher
POST /api/hr/payroll/:id/unapprove { "reason": "Attendance was incomplete" }   # reverses the accrual
GET  /api/invoices/:id/pdf                                           # branded tax invoice PDF
POST /api/hr/payroll/generate     { "year": 2026, "month": 6,
                                    "deductions": { "2": 8181.82 } }   # taka, per employee id
GET  /api/hr/payslips/:id/pdf                                        # payslip PDF
```

Every controller carries JSDoc request/response examples — see `backend/src/modules/*/​*.controller.ts`.

## Production build

```bash
cd backend  && npm run build && npm start        # compiles to dist/, serves :4000
cd frontend && npm run build && npm start        # serves static dist/ on $PORT
```

Before going live: set strong `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` and a real `CORS_ORIGIN` in `backend/.env`, point `VITE_API_URL` (frontend `.env`) at your API origin, and run MySQL with regular encrypted backups. Railway should use `/api/ready` as the health check so a server with a dead database is not marked healthy. Uploaded branding files are raster-only and should be backed by persistent storage in production.

Password recovery uses email OTP. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, and `MAIL_FROM` in the backend environment before enabling it in production.

`BUSINESS_TIMEZONE` (default `Asia/Dhaka`) decides which calendar day the
posting engine treats as "today". It must match where the business actually
keeps its books, or vouchers dated today will be rejected as future-dated for
the hours the server's UTC date lags behind.

## Railway deployment

Create two Railway services from this repository:

| Service | Root directory | Build command | Start command |
|---|---|---|---|
| Backend API | `backend` | `npm run build` | `npm start` |
| Frontend | `frontend` | `npm ci && npm run build` | `npm start` |

The service-level `railway.json` files in `backend/` and `frontend/` define the same commands plus health checks.

Backend environment variables:

```bash
NODE_ENV=production
CORS_ORIGIN=https://erp.tripflybd.com,https://<frontend-service>.up.railway.app
JWT_ACCESS_SECRET=<strong-random-secret>
JWT_REFRESH_SECRET=<different-strong-random-secret>
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=7
```

Connect the Railway MySQL database to the backend service. The API accepts Railway's native `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD`, and `MYSQLDATABASE` variables, plus `DATABASE_URL` / `MYSQL_URL` when available. Manual `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` still work for non-Railway deployments.

Frontend environment variables:

```bash
VITE_API_URL=https://<backend-service>.up.railway.app
```

Database import order for a new/empty Railway MySQL database:

```bash
mysql "$MYSQL_URL" < database/schema.sql
mysql "$MYSQL_URL" < database/seed.sql
```

The schema script now targets the selected database from your MySQL connection string, which is safer for Railway managed database names. It drops and recreates application tables, so run it only on an empty database or during an intentional reset. Add `erp.tripflybd.com` as the frontend service custom domain, then point the DNS record to the Railway target shown in the domain setup screen.

See [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md) for the complete Railway/Vercel checklist, environment variable lists, and production verification notes.

## Repository layout

```
tripfly-erp/
├── database/          schema.sql · seed.sql
├── backend/
│   └── src/
│       ├── config/        env, MySQL pool, transactions
│       ├── middleware/    auth (JWT), rbac, audit, error handler
│       ├── utils/         money (integer-cent math), numbering, system ledgers
│       └── modules/       auth · accounting · reports · inventory · crm
│                          bookings · payments · invoices · hr · dashboard
└── frontend/
    └── src/
        ├── api/           axios client (token refresh, PDF opener)
        ├── components/    UI kit · AppShell (sidebar, topbar, dark mode)
        └── pages/         Dashboard · Accounting · Reports · Inventory · CRM
                           Bookings · Invoices · Payments · HR · Settings
```
