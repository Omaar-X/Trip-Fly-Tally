-- ============================================================================
--  Migration 003 — Tally-parity accounting core
-- ----------------------------------------------------------------------------
--  Additive only. Safe to run on a live database; safe to re-run.
--
--  What this migration makes possible:
--
--   1. FINANCIAL YEAR + PERIOD LOCK
--      The books now have a beginning and a lockable past. Postings before
--      `books_begin_from` or on/before `books_locked_upto` are refused by the
--      posting engine, so a closed and audited year can no longer move.
--
--   2. ATOMIC PER-FY DOCUMENT NUMBERING
--      `voucher_sequences` replaces the old SELECT COUNT(*) approach. Numbers
--      are drawn per (company, document kind, financial year) by an atomic
--      UPDATE, so concurrent posting cannot collide and the sequence restarts
--      each financial year exactly as Tally does.
--
--   3. INVENTORY THAT REACHES THE LEDGER
--      Stock movements gain a supplier and a booked value so every IN/OUT can
--      post a real voucher. `stock_entries.voucher_id` already existed but was
--      never written; it is now the link between the stock journal and the
--      books.
--
--   4. THE LEDGERS THE ABOVE NEEDS
--      Separate Nagad and card-settlement money ledgers (they used to collapse
--      into the bKash and bank ledgers, making both unreconcilable), plus
--      Stock in Hand / Cost of Goods Sold / Stock Adjustment.
--
--  Usage:
--    mysql -u root -p --default-character-set=utf8mb4 erp_db < database/migrations/003_tally_parity.sql
-- ============================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1 · companies — financial year and period lock
-- ---------------------------------------------------------------------------
-- fy_start_month   first month of the financial year (Bangladesh: July = 7).
-- books_begin_from earliest date any voucher may carry. Opening balances are
--                  understood to be the position on the day before this date.
-- books_locked_upto everything on or before this date is frozen.

SET @sql := (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE companies ADD COLUMN fy_start_month TINYINT UNSIGNED NOT NULL DEFAULT 7 AFTER currency',
    'SELECT "companies.fy_start_month already present"')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'companies' AND column_name = 'fy_start_month');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE companies ADD COLUMN books_begin_from DATE NULL AFTER fy_start_month',
    'SELECT "companies.books_begin_from already present"')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'companies' AND column_name = 'books_begin_from');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE companies ADD COLUMN books_locked_upto DATE NULL AFTER books_begin_from',
    'SELECT "companies.books_locked_upto already present"')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'companies' AND column_name = 'books_locked_upto');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Existing installs: start the books at the beginning of the current BD
-- financial year rather than leaving them open to any date in history.
UPDATE companies
   SET books_begin_from = MAKEDATE(
         IF(MONTH(CURDATE()) >= 7, YEAR(CURDATE()), YEAR(CURDATE()) - 1), 1)
                          + INTERVAL 6 MONTH
 WHERE books_begin_from IS NULL;

-- ---------------------------------------------------------------------------
-- 2 · voucher_sequences — atomic per-financial-year document numbering
-- ---------------------------------------------------------------------------
-- doc_kind is a voucher type (JOURNAL, SALES, …) or a document family
-- (INVOICE, BOOKING, PAYMENT). fy_label is the financial year the document
-- falls in, e.g. '2026-2027'.

CREATE TABLE IF NOT EXISTS voucher_sequences (
  id         INT UNSIGNED   AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED   NOT NULL,
  doc_kind   VARCHAR(30)    NOT NULL,
  fy_label   CHAR(9)        NOT NULL,
  last_no    INT UNSIGNED   NOT NULL DEFAULT 0,
  updated_at TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_vseq_company FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_vseq (company_id, doc_kind, fy_label)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------------
-- 3 · stock_entries — supplier and booked value, so a movement can post
-- ---------------------------------------------------------------------------
SET @sql := (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE stock_entries ADD COLUMN supplier_id INT UNSIGNED NULL AFTER warehouse_id',
    'SELECT "stock_entries.supplier_id already present"')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'stock_entries' AND column_name = 'supplier_id');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE stock_entries ADD COLUMN value_amount DECIMAL(14,2) NOT NULL DEFAULT 0.00 AFTER rate',
    'SELECT "stock_entries.value_amount already present"')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'stock_entries' AND column_name = 'value_amount');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE stock_entries ADD CONSTRAINT fk_se_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id)',
    'SELECT "stock_entries.fk_se_supplier already present"')
  FROM information_schema.table_constraints
  WHERE table_schema = DATABASE() AND table_name = 'stock_entries' AND constraint_name = 'fk_se_supplier');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- Backfill value for movements recorded before this migration so the stock
-- journal and any future ledger reconciliation start from the same numbers.
UPDATE stock_entries SET value_amount = ROUND(quantity * rate, 2) WHERE value_amount = 0.00;

-- ---------------------------------------------------------------------------
-- 4 · the system ledgers the engine now resolves by name
-- ---------------------------------------------------------------------------
-- Nagad used to post into the bKash wallet ledger and card settlements
-- straight into the bank account. Both are separate real-world balances and
-- neither could be reconciled; they get their own ledgers here.

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, v.name, 0.00, v.side, 1
  FROM companies c
  -- The wanted-ledgers list is joined BEFORE ledger_groups: MySQL resolves
  -- ON-clause references left to right, so v must already be in scope.
  JOIN (
    SELECT 'Nagad Merchant Wallet'      AS name, 'Bank Accounts'    AS group_name, 'DR' AS side
    UNION ALL SELECT 'Card Settlement Account', 'Bank Accounts',    'DR'
    UNION ALL SELECT 'Stock in Hand',           'Stock-in-Hand',    'DR'
    UNION ALL SELECT 'Cost of Goods Sold',      'Direct Expenses',  'DR'
    UNION ALL SELECT 'Stock Adjustment',        'Direct Expenses',  'DR'
  ) v
  JOIN ledger_groups g ON g.company_id = c.id AND g.name = v.group_name
 WHERE NOT EXISTS (
   SELECT 1 FROM ledgers l WHERE l.company_id = c.id AND l.name = v.name);

-- ---------------------------------------------------------------------------
-- 5 · protect the ledgers the engine depends on
-- ---------------------------------------------------------------------------
-- Nominal (INCOME/EXPENSE) ledgers must never carry an opening balance: the
-- P&L is a period statement and reads movement only, so an opening on one of
-- them lands on no side of the Balance Sheet and silently unbalances it. Any
-- such value left by an earlier install is cleared here; the API now refuses
-- to create one.
UPDATE ledgers l
  JOIN ledger_groups g ON g.id = l.group_id
   SET l.opening_balance = 0.00
 WHERE g.nature IN ('INCOME', 'EXPENSE') AND l.opening_balance <> 0.00;

SELECT 'Migration 003 (Tally parity) applied.' AS status;
