-- ============================================================================
--  Voucher reversal, generic payment counterparties, and warehouse seeding.
--
--  Fixes two confirmed accounting-workflow defects:
--    BUG 1  Cancelling a CONFIRMED booking reversed only the SALES voucher,
--           leaving the supplier PURCHASE voucher (Dr Cost of Services /
--           Cr Supplier A/P) permanently on the books. P&L and Balance Sheet
--           were wrong while the Trial Balance still balanced, so nothing
--           surfaced the error.
--    BUG 2  Money could only leave the company towards a SUPPLIER, so a
--           customer refund was impossible — and cancelling a paid booking
--           demanded a refund that the software could not perform.
--
--  schema.sql is a drop-and-recreate script and must never be re-run against
--  a live database with real data. This file only ADDs columns/tables/rows and
--  is safe to run once against an existing database.
--
--  Not applied automatically — review it and run it yourself:
--    mysql -u <user> -p <database> < database/migrations/002_voucher_reversal_and_refunds.sql
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. VOUCHER REVERSAL
--
--    Vouchers are immutable and are never deleted. A correction is always a
--    NEW voucher whose entries mirror the original (DR <-> CR), linked to it
--    in both directions so the audit trail reads forwards and backwards:
--
--        SV-2026-00014 (status REVERSED, reversed_by_voucher_id = 61)
--             |
--             +--> CN-2026-00003 (id 61, reversal_of_voucher_id = 55)
--
--    status  ACTIVE    normal, still standing
--            REVERSED  superseded by the voucher in reversed_by_voucher_id
--
--    A reversal voucher is itself ACTIVE (it is a real posting that stands on
--    its own); `reversal_of_voucher_id IS NOT NULL` is what identifies it as a
--    reversal. A separate VOID state is deliberately not introduced: nothing in
--    this ledger is ever cancelled without a balancing counter-posting, so
--    "voided" and "reversed" would describe the same physical fact.
-- ---------------------------------------------------------------------------
ALTER TABLE vouchers
  ADD COLUMN status                 ENUM('ACTIVE','REVERSED') NOT NULL DEFAULT 'ACTIVE' AFTER total_amount,
  ADD COLUMN reversal_of_voucher_id BIGINT UNSIGNED NULL AFTER status,
  ADD COLUMN reversed_by_voucher_id BIGINT UNSIGNED NULL AFTER reversal_of_voucher_id,
  ADD COLUMN reversed_by            INT UNSIGNED    NULL AFTER reversed_by_voucher_id,
  ADD COLUMN reversed_at            DATETIME        NULL AFTER reversed_by,
  ADD COLUMN reversal_reason        VARCHAR(500)    NULL AFTER reversed_at;

ALTER TABLE vouchers
  ADD CONSTRAINT fk_v_reversal_of  FOREIGN KEY (reversal_of_voucher_id) REFERENCES vouchers(id),
  ADD CONSTRAINT fk_v_reversed_by  FOREIGN KEY (reversed_by_voucher_id) REFERENCES vouchers(id),
  ADD CONSTRAINT fk_v_reversed_usr FOREIGN KEY (reversed_by)            REFERENCES users(id),
  ADD INDEX idx_v_reversal_of (reversal_of_voucher_id),
  ADD INDEX idx_v_status      (company_id, status);


-- ---------------------------------------------------------------------------
-- 2. BOOKING -> PURCHASE VOUCHER LINK
--
--    The sales voucher was always reachable through invoices.voucher_id, but
--    the supplier-cost voucher was only findable by matching `reference` to the
--    booking number — too weak to drive a financial reversal. Store it.
-- ---------------------------------------------------------------------------
ALTER TABLE bookings
  ADD COLUMN purchase_voucher_id BIGINT UNSIGNED NULL AFTER invoice_id,
  ADD CONSTRAINT fk_b_purchase_voucher FOREIGN KEY (purchase_voucher_id)
      REFERENCES vouchers(id) ON DELETE SET NULL,
  ADD INDEX idx_b_purchase_voucher (purchase_voucher_id);

-- Backfill from historical data: the confirm path has always written the
-- booking_no into vouchers.reference for the PURCHASE voucher it posted.
UPDATE bookings b
   JOIN vouchers v
     ON v.company_id   = b.company_id
    AND v.voucher_type = 'PURCHASE'
    AND v.reference    = b.booking_no
    SET b.purchase_voucher_id = v.id
  WHERE b.purchase_voucher_id IS NULL;


-- ---------------------------------------------------------------------------
-- 3. GENERIC PAYMENT COUNTERPARTY
--
--    `direction` alone could not express a customer refund, because OUT was
--    hard-wired to suppliers. The canonical model is now
--    (direction, counterparty_type) which spans all four real-world cases:
--
--        IN  + CUSTOMER   customer pays us          (receipt)
--        OUT + CUSTOMER   we pay a customer back    (refund)      <-- was impossible
--        OUT + SUPPLIER   we pay a supplier         (payment)
--        IN  + SUPPLIER   supplier pays us back     (supplier credit)
--
--    customer_id / supplier_id are RETAINED and kept in sync by the service
--    layer, so every existing query, report, join and PDF continues to work
--    unchanged. They are the compatibility view; the pair above is the truth.
-- ---------------------------------------------------------------------------
ALTER TABLE payments
  ADD COLUMN counterparty_type    ENUM('CUSTOMER','SUPPLIER') NULL AFTER direction,
  ADD COLUMN counterparty_id      INT UNSIGNED    NULL AFTER counterparty_type,
  ADD COLUMN refund_of_payment_id BIGINT UNSIGNED NULL AFTER invoice_id,
  ADD COLUMN reason               VARCHAR(255)    NULL AFTER notes;

ALTER TABLE payments
  ADD CONSTRAINT fk_p_refund_of FOREIGN KEY (refund_of_payment_id) REFERENCES payments(id),
  ADD INDEX idx_p_counterparty (company_id, counterparty_type, counterparty_id),
  ADD INDEX idx_p_refund_of    (refund_of_payment_id);

-- Backfill the canonical pair from the legacy columns.
UPDATE payments
   SET counterparty_type = 'CUSTOMER', counterparty_id = customer_id
 WHERE customer_id IS NOT NULL AND counterparty_type IS NULL;

UPDATE payments
   SET counterparty_type = 'SUPPLIER', counterparty_id = supplier_id
 WHERE supplier_id IS NOT NULL AND counterparty_type IS NULL;


-- ---------------------------------------------------------------------------
-- 4. INVENTORY IS USABLE OUT OF THE BOX
--
--    warehouses had no create route and seed.sql shipped none, so every stock
--    movement (which requires a warehouse_id) was impossible. Give each
--    existing company a default warehouse.
-- ---------------------------------------------------------------------------
INSERT INTO warehouses (company_id, name, location, is_active)
SELECT c.id, 'Main Warehouse', NULL, 1
  FROM companies c
 WHERE NOT EXISTS (
   SELECT 1 FROM warehouses w WHERE w.company_id = c.id AND w.name = 'Main Warehouse'
 );
