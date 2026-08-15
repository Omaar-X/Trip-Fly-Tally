# Accounting Workflow Fixes — Voucher Reversal & Customer Refunds

Release notes for the fix of two confirmed accounting-workflow defects, plus the
inventory, export-security and error-handling work that shipped with them.

The double-entry engine itself was correct and is unchanged. Every defect below
lived in the business workflow *around* it.

---

## 1. What was wrong

### BUG 1 — cancellation left half the books standing

Confirming a booking posts **two** vouchers:

| Voucher | Entries |
|---|---|
| `SALES` | Dr Customer A/R · Cr Sales Revenue · Cr VAT Payable |
| `PURCHASE` | Dr Cost of Services · Cr Supplier A/P |

Cancelling reversed only the `SALES` voucher. The supplier cost and the payable
stayed on the books forever.

Measured on a real booking (cost ৳50,000, sale ৳56,500, confirm then cancel):

```
P&L after cancel        income 0 · expense 50,000 · net −50,000
Balance Sheet           phantom ৳50,000 payable to a supplier owed nothing
Trial Balance           still balanced
```

Because both sides of the orphaned voucher remained, the Trial Balance kept
balancing — so no integrity check ever surfaced it. Every cancelled
supplier-backed booking permanently overstated expenses and creditors.

### BUG 2 — customer refunds were impossible, which deadlocked cancellation

`direction: 'OUT'` hard-required a `supplierId`. There was no way to return money
to a customer. Meanwhile cancellation refused a settled invoice with *"refund the
payment first, then cancel"* — instructing an action the software could not
perform. A customer who paid and then cancelled left the booking stuck
`CONFIRMED` with a `PAID` invoice permanently.

---

## 2. How they were fixed

### Vouchers are immutable; corrections are postings

A voucher is never edited or deleted. Reversing one posts a **new** voucher whose
entries mirror the original — every `DR` becomes a `CR` of the same amount
against the same ledger — linked in both directions:

```
SV-2026-00014   status REVERSED   reversed_by_voucher_id ─┐
                                                          ▼
CN-2026-00003   reversal_of_voucher_id ───────────────────┘
```

`vouchers.status` is `ACTIVE` or `REVERSED`. A reversal voucher is itself
`ACTIVE` — it is a real posting that stands on its own; a non-null
`reversal_of_voucher_id` is what identifies it as a reversal. A separate `VOID`
state was deliberately not introduced: nothing in this ledger is cancelled
without a balancing counter-posting, so "voided" and "reversed" would name the
same physical fact.

Reversal voucher types follow accounting convention:

| Original | Reversal |
|---|---|
| `SALES` | `CREDIT_NOTE` |
| `PURCHASE` | `DEBIT_NOTE` |
| `RECEIPT` | `PAYMENT` |
| `PAYMENT` | `RECEIPT` |
| `JOURNAL` / `CONTRA` | same type |

### Posting and unwinding now live together

`bookingAccountingService` owns **both** `postConfirmationTx()` and
`reverseBookingAccountingTx()`. They sit in one file specifically so a future
change to what confirmation posts cannot silently leave cancellation behind —
which is exactly how BUG 1 arose.

### Payments use a generic counterparty

`(direction, counterpartyType)` replaces the hard-wired customer/supplier split
and spans all four real cases:

| direction | counterpartyType | Meaning | Voucher |
|---|---|---|---|
| `IN` | `CUSTOMER` | Customer pays us | `RECEIPT` — Dr Cash · Cr Customer A/R |
| `OUT` | `CUSTOMER` | **Customer refund** | `PAYMENT` — Dr Customer A/R · Cr Cash |
| `OUT` | `SUPPLIER` | Supplier payment | `PAYMENT` — Dr Supplier A/P · Cr Cash |
| `IN` | `SUPPLIER` | Supplier credit | `RECEIPT` — Dr Cash · Cr Supplier A/P |

### Cancellation settlement rules

| Invoice state | Behaviour |
|---|---|
| Unpaid | Cancels immediately |
| Partially paid | `409` — refund the collected amount first |
| Fully paid | `409` — refund in full first |

The `409` now names the exact call to make, and that call exists.

---

## 3. API changes

### `POST /api/payments` — extended, backward compatible

New optional fields:

| Field | Type | Meaning |
|---|---|---|
| `counterpartyType` | `"CUSTOMER"` \| `"SUPPLIER"` | Canonical counterparty; send with `counterpartyId` |
| `counterpartyId` | number | |
| `refundOfPaymentId` | number | Links a refund to the receipt it reverses |
| `reason` | string(255) | Why a refund was issued |

`customerId` / `supplierId` are **still accepted** and mean exactly the same
thing. Existing callers need no change.

Customer refund (previously impossible):

```http
POST /api/payments
{
  "direction": "OUT",
  "counterpartyType": "CUSTOMER",
  "counterpartyId": 1,
  "invoiceId": 6,
  "refundOfPaymentId": 12,
  "method": "BKASH",
  "amount": 42000,
  "paymentDate": "2026-08-03",
  "reason": "Customer cancelled the tour"
}
```

Response adds `isRefund`, `counterpartyType`, `counterpartyId`, and `invoice.due`.
Refunds are numbered `REF-YYYY-NNNNN` instead of `PMT-YYYY-NNNNN`.

`GET /api/payments` accepts `?counterpartyType=` and returns
`counterparty_type`, `counterparty_id`, `counterparty_name`, `reason`,
`refund_of_payment_id`.

### `POST /api/bookings/:id/cancel` — richer response

```jsonc
{
  "bookingId": 8,
  "status": "CANCELLED",
  "creditNoteNo": "CN-2026-00003",            // retained for existing clients
  "salesReversalVoucherNo": "CN-2026-00003",  // new
  "purchaseReversalVoucherNo": "DN-2026-00002", // new
  "invoiceVoided": true                        // new
}
```

### `GET /api/vouchers` and `/api/vouchers/:id` — reversal metadata

List adds `status`, `reversal_of_voucher_id`, `reversed_by_voucher_id`. Detail
additionally resolves `reversed_by_name`, `reversal_of_voucher_no`,
`reversed_by_voucher_no`.

### Inventory — warehouse CRUD (new)

| Method | Path | Roles |
|---|---|---|
| `GET` | `/api/inventory/warehouses` | any authenticated |
| `POST` | `/api/inventory/warehouses` | Accountant, Admin, CEO |
| `PUT` | `/api/inventory/warehouses/:id` | Accountant, Admin, CEO |
| `DELETE` | `/api/inventory/warehouses/:id` | Accountant, Admin, CEO |

`GET` now includes `movement_count`. Duplicate names within a company are
rejected with `409`. `DELETE` removes a warehouse that has never held stock and
**deactivates** one that has movements, so the stock journal keeps its history.
Stock cannot be moved into an inactive warehouse.

### Admin export — secrets redacted

`GET /api/admin/database/tables/:table`, its CSV export, and
`GET /api/admin/database/export.json` no longer return credential columns. The
row browser adds `redactedColumns`; the backup adds a `redacted` map, so exports
are self-describing rather than quietly lossy.

### Error responses — database constraints mapped

| Condition | Was | Now |
|---|---|---|
| Missing referenced row (bad `ledgerId`) | `500` | `400` |
| Duplicate key | `500` | `409` |
| Value out of range / too long | `500` | `400` |
| Row still referenced | `500` | `409` |
| Deadlock / lock timeout | `500` | `409` (retryable) |

Messages are generic by design — the raw driver text carries table, column and
constraint names, which is schema disclosure. The real error is still logged
server-side.

---

## 4. Migration

```bash
mysql -u <user> -p <database> < database/migrations/002_voucher_reversal_and_refunds.sql
```

Additive only — no drops, no data loss. It adds the reversal columns to
`vouchers`, `bookings.purchase_voucher_id`, the counterparty columns to
`payments`, and gives each company a **Main Warehouse**.

Two backfills run automatically:

- `bookings.purchase_voucher_id` is recovered from historical data by matching
  `vouchers.reference` to `booking_no` on `PURCHASE` vouchers.
- `payments.counterparty_type` / `counterparty_id` are derived from the existing
  `customer_id` / `supplier_id`.

`schema.sql` and `seed.sql` were updated to match, so fresh installs land in the
same shape.

> **Historical data note.** The migration does not retroactively unwind bookings
> that were cancelled *before* it ran. Those still carry the orphaned supplier
> cost and payable described in BUG 1. To find them:
>
> ```sql
> SELECT b.booking_no, v.voucher_no, v.total_amount
>   FROM bookings b
>   JOIN vouchers v ON v.id = b.purchase_voucher_id
>  WHERE b.status = 'CANCELLED' AND v.status = 'ACTIVE';
> ```
>
> Each row is a supplier payable that should not exist. Correct them with a
> reviewed journal voucher — deliberately not automated, since some cancellations
> genuinely do owe the supplier a cancellation fee.

---

## 5. Tests

```bash
npm test              # 110 unit tests, no database required
npm run test:integration   # 10 end-to-end tests, needs a migrated MySQL
```

The integration suite skips itself when no database is reachable, so `npm test`
stays green in CI without MySQL.
