# Customer Outstanding Balance — Analysis

**Date:** 2026-07-29
**Status:** Analysis only. No code has been modified for this issue yet.
**Method:** Searched CRM, Reports, Dashboard, Invoices, Payments, Bookings, Accounting, and PDF rendering (backend `src/` in full) plus every frontend page that displays an outstanding/due/receivable figure, for every place a customer's money-owed is calculated.

## Search coverage note

Two features named in the brief don't exist as dedicated code paths — confirmed by search, not assumed:
- **Aging Report** — no route, controller, or service function for invoice/receivable aging (bucketed by days overdue) exists anywhere in the repo.
- **Collection Report** — no dedicated "collections" report exists either. The closest related logic is payment recording against an invoice (`payments.service.ts`, documented below under a different heading since it's not itself an outstanding-balance calculation).

Everything found falls into two genuinely different concepts that must not be conflated in the new service:
- **A. Customer-level outstanding** (ledger-based, all-time, one figure per customer) — this is "Customer Outstanding Balance" as named in the issue.
- **B. Invoice-level due** (`invoice.total − invoice.paid_amount`, one figure per invoice) — a different, narrower concept. Related, but not the same calculation, and not ledger-based (ignores opening balances and any non-invoice ledger adjustment like a manual journal entry or a credit note that doesn't touch `paid_amount`).

---

## A. Customer-level outstanding (ledger-based)

### A1 — `reportsService.customerOutstanding` (canonical / most correct version)
- **File:** `backend/src/modules/reports/reports.service.ts`
- **Function:** `customerOutstanding(companyId)`, lines 130-142
- **Formula:** `outstanding = (opening_balance signed by opening_type) + SUM(voucher_entries signed by entry_type)`, rounded to 2dp, **filtered to non-zero balances only**
- **SQL:**
  ```sql
  SELECT c.id, c.name, c.phone, c.credit_limit,
         ROUND(CASE WHEN l.opening_type='DR' THEN l.opening_balance ELSE -l.opening_balance END
         + COALESCE(SUM(CASE WHEN ve.entry_type='DR' THEN ve.amount ELSE -ve.amount END),0), 2) AS outstanding
    FROM customers c
    JOIN ledgers l ON l.id = c.ledger_id
    LEFT JOIN voucher_entries ve ON ve.ledger_id = l.id
   WHERE c.company_id = ?
   GROUP BY c.id, c.name, c.phone, c.credit_limit, l.opening_balance, l.opening_type
   HAVING outstanding <> 0
   ORDER BY outstanding DESC
  ```
- **Reached by:** `GET /api/reports/customer-outstanding` ([reports.controller.ts:62](backend/src/modules/reports/reports.controller.ts:62), [reports.routes.ts:15](backend/src/modules/reports/reports.routes.ts:15)) → Reports page "Customer Outstanding" tab ([Reports.tsx:16](frontend/src/pages/reports/Reports.tsx:16)).
- **Differences from A2:** has `HAVING outstanding <> 0` (hides zero-balance customers); doesn't return `credit_limit` comparison itself (frontend does that); grouped by `c.id, c.name, c.phone, c.credit_limit` explicitly.

### A2 — `crmService.listCustomers` (duplicate, drifted)
- **File:** `backend/src/modules/crm/crm.service.ts`
- **Function:** `listCustomers` (arrow function), lines 16-25
- **Formula:** Identical arithmetic to A1 — same opening-balance-signed-plus-summed-entries formula.
- **SQL:**
  ```sql
  SELECT c.*, ROUND(
         CASE WHEN l.opening_type='DR' THEN l.opening_balance ELSE -l.opening_balance END
         + COALESCE(SUM(CASE WHEN ve.entry_type='DR' THEN ve.amount ELSE -ve.amount END),0), 2) AS outstanding
    FROM customers c
    JOIN ledgers l ON l.id = c.ledger_id
    LEFT JOIN voucher_entries ve ON ve.ledger_id = l.id
   WHERE c.company_id = ?
   GROUP BY c.id, l.opening_balance, l.opening_type
   ORDER BY c.name
  ```
- **Reached by:** `GET /api/crm/customers` ([crm.controller.ts:19](backend/src/modules/crm/crm.controller.ts:19)) → CRM page customer list ([Crm.tsx:12](frontend/src/pages/crm/Crm.tsx:12), rendered at Crm.tsx:49-51).
- **Differences from A1:** **No `HAVING outstanding <> 0`** — zero-balance customers ARE included here but NOT in the Reports version. **This is the confirmed drift**: the same "customer outstanding" concept returns a different row set depending on whether you look at CRM or Reports. Also selects `c.*` (every customer column) instead of a narrow field list, and orders by name instead of outstanding amount. `GROUP BY` omits `c.name`/`c.phone`/`c.credit_limit` (relies on MySQL's `ONLY_FULL_GROUP_BY`-permissive functional-dependency inference via `c.id`, which works but is a different style than A1's explicit grouping).

### A3 — `crmService.outstanding` (dead code, delegates correctly)
- **File:** `backend/src/modules/crm/crm.service.ts`
- **Function:** `outstanding: (companyId) => reportsService.customerOutstanding(companyId)`, line 90
- **Formula / SQL:** N/A — it's a passthrough to A1, not its own implementation.
- **Reached by:** nothing. No controller or route calls `crmService.outstanding`. It's unused.
- **Differences:** None from A1 (it correctly delegates) — but its existence, unused, alongside `listCustomers`' own inline duplicate (A2), suggests an earlier fix was half-applied: something already tried to point CRM at the shared Reports calculation and it never got wired up.

---

## B. Invoice-level due (`total − paid_amount`)

Not the same concept as A (see note above), but listed because the brief said to search "Invoice" and "any helper/service," and because the new service is required to have zero duplicated calculations — this simpler formula is independently reimplemented five times across four files.

### B1 — `invoicesService.list`
- **File:** `backend/src/modules/invoices/invoices.service.ts`, line 27: `(i.total - i.paid_amount) AS due`
- **Used by:** `GET /api/invoices` → Invoices page list ([Invoices.tsx:10](frontend/src/pages/invoices/Invoices.tsx:10), rendered at Invoices.tsx:49-51) and the "open invoice" picker in the Payments page ([Payments.tsx:14](frontend/src/pages/payments/Payments.tsx:14)).

### B2 — `invoicesService.get`
- **File:** `backend/src/modules/invoices/invoices.service.ts`, line 39: `(i.total - i.paid_amount) AS due`
- **Used by:** `GET /api/invoices/:id` → Invoice detail view ([Invoices.tsx:112](frontend/src/pages/invoices/Invoices.tsx:112)).

### B3 — `dashboardService.summary` (company-wide aggregate, NOT per-customer)
- **File:** `backend/src/modules/dashboard/dashboard.service.ts`, lines 32-34
- **Formula:** `SUM(total - paid_amount)` across all `UNPAID`/`PARTIAL` invoices for the whole company — a single number, not per-customer.
- **SQL:** `SELECT COALESCE(SUM(total - paid_amount), 0) AS due FROM invoices WHERE company_id = ? AND status IN ('UNPAID','PARTIAL')`
- **Used by:** Dashboard "Receivables" figure ([Dashboard.tsx:16](frontend/src/pages/Dashboard.tsx:16), shown under Cash & Bank at Dashboard.tsx:120).
- **Important difference from A1/A2:** this is invoice-driven, not ledger-driven. It will **not** match `SUM(A1.outstanding)` in general, because it ignores: opening balances on customer ledgers, any manual journal/adjustment posted directly to a customer's ledger, and credit/debit notes that reverse a sale without changing `paid_amount` (see `bookings.service.ts`'s `cancel()`, which posts a `CREDIT_NOTE` voucher and sets the invoice to `VOID` — a voided invoice is excluded from B3's `status IN ('UNPAID','PARTIAL')` filter entirely, while A1/A2's ledger-based sum reflects the credit note's actual effect on the customer's ledger balance). This is a real, pre-existing source of potential divergence between "receivables" as shown on the Dashboard and "outstanding" as shown on CRM/Reports — not introduced by anything recent, but worth the requester's awareness since it's the kind of thing "one source of truth" is meant to fix.

### B4 — `paymentsService.record` (validation, not display)
- **File:** `backend/src/modules/payments/payments.service.ts`, line 90: `const due = round2(Number(inv.total) - Number(inv.paid_amount));`
- **Used for:** rejecting a payment that would overpay an invoice (line 91-92). Not shown to the user directly, but the same formula, independently written.

### B5 — `invoice.pdf.ts` (PDF rendering)
- **File:** `backend/src/modules/invoices/invoice.pdf.ts`, line 104: `const due = Number(invoice.total) - Number(invoice.paid_amount);`
- **Used for:** the "AMOUNT DUE" / "PAID IN FULL" strip on the printed invoice PDF.

---

## C. Related but out-of-scope: generic ledger statement

- **File:** `backend/src/modules/accounting/accounting.service.ts` (`ledgerStatement`, lines 68-83) + `accounting.repository.ts` (`ledgerStatement` query, lines 42-49)
- **What it is:** a **date-ranged, any-ledger** statement (not customer-specific — works for any ledger in the chart of accounts) that computes a running balance by replaying voucher entries in an imperative loop, starting from the ledger's static `opening_balance` column.
- **Why it's listed:** the issue asks for a `getCustomerStatement(customerId)` method on the new service, and this is the only existing "statement with running balance" logic in the codebase — worth knowing about as prior art, even though it isn't a duplicate of the customer-outstanding calculation itself (different shape: a list of transactions with a running balance, not a single total) and isn't customer-specific today (nothing currently calls it with a customer's `ledger_id`).
- **A caveat worth flagging, not fixing here:** `ledgerStatement`'s closing balance is only correct when `from` equals the ledger's true inception date. If called with a `from` later than that, entries between inception and `from` are silently excluded from the running balance, while the (unfiltered-by-date) `opening_balance` column is still added in full — so the reported "closing balance" would not actually reflect the balance as of `to` in that case. This is a pre-existing, separate issue from the outstanding-balance duplication and is **not part of this fix** unless you want `getCustomerStatement` to inherit and correct this behavior — flagging so the decision is explicit rather than silently carried over.

---

## Summary table

| # | File | Function | Concept | Duplicate of |
|---|---|---|---|---|
| A1 | `reports.service.ts:130` | `customerOutstanding` | Per-customer, ledger-based, all-time | — (canonical) |
| A2 | `crm.service.ts:16` | `listCustomers` | Same as A1 | **Duplicates A1, drifted** (missing `HAVING <> 0`) |
| A3 | `crm.service.ts:90` | `outstanding` | Delegates to A1 | Not a duplicate — dead code |
| B1 | `invoices.service.ts:27` | `list` | Per-invoice due | — |
| B2 | `invoices.service.ts:39` | `get` | Per-invoice due | Duplicates B1's formula |
| B3 | `dashboard.service.ts:33` | `summary` | Company-wide receivables (invoice-based) | Duplicates B1's formula, aggregated; diverges from A1 conceptually |
| B4 | `payments.service.ts:90` | `record` | Per-invoice due (validation) | Duplicates B1's formula |
| B5 | `invoice.pdf.ts:104` | (PDF render) | Per-invoice due | Duplicates B1's formula |
| C | `accounting.service.ts:68` | `ledgerStatement` | Any-ledger, date-ranged running balance | Different shape, not a duplicate; relevant prior art for `getCustomerStatement` |

**Frontend:** confirmed to be a pure display layer for all of the above — no page recomputes outstanding/due/receivable figures client-side; every page just renders whatever field the corresponding backend endpoint already returns (`c.outstanding`, `i.due`, `summary.receivables`, etc.). No frontend changes are anticipated for the centralization itself, only for wherever the underlying API response shape might change.

## Recommendation for the next phase (not implemented yet)

Build `CustomerOutstandingService` around the **A1 formula** (it's the more complete/correct one — includes the zero-balance filter that makes sense for "who owes us money" views) and make `listCustomers` (A2) call it instead of reimplementing the SQL, using a parameter to control whether zero-balance customers are included (CRM's customer list arguably *should* show every customer including zero-balance ones — that's a product decision to confirm with you, not something to assume). Whether to also fold the B-series (invoice-level `due`) into the same service, or leave it as a separate concern since it's a genuinely different calculation, is also worth confirming before implementation — my inclination is to leave B alone (it's simple, low-risk, and not what "customer outstanding balance" refers to), but flagging it since the issue said "no duplicated calculation."
