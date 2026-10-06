-- ============================================================================
--  021 · MONTH-END RECEIVABLE, AS THE WORKBOOKS STATE IT
--  Apply once after 020_previous_data_bookings_confirmed.sql.
--
--  Re-runnable: CREATE TABLE IF NOT EXISTS, and the ALTERs go through an
--  information_schema check.
-- ============================================================================
--
--  WHY THIS EXISTS
--
--  The first cut of the Accounts Receivable section computed
--  SUM(debit) − SUM(credit) over the imported sales rows and called the result
--  outstanding. That was wrong by about eight times: BDT 224,334,437 against a
--  real receivable of 28,655,101.60.
--
--  The reason is in the sources. A monthly sales register records what was
--  BILLED and says nothing about what came back — only the partner ledgers and
--  the three Mar–May 2024 sheets have a credit column at all. So billed minus
--  the few receipts that happen to be recorded is not a receivable; it is
--  turnover with a rounding error knocked off it.
--
--  Every workbook already carries the real answer: a one-page balance sheet on
--  an ACCOUNTS tab with a block headed ACCOUNTS RECEIVABLE — one line per party
--  who still owes, and a stated total. This table holds those lines.
--
--  The extraction is bounded by the total cell's own SUM() range, and it
--  reconciles: 33 of the 34 blocks in the archive add up to their stated total
--  to the paisa. The one that does not (`SALES-APR -25 :: ACCOUNTS (2)`, whose
--  formula ends `+164255`) records the gap in `receivable_discrepancy` rather
--  than hiding it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sales_file_receivables (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sales_file_id BIGINT UNSIGNED NOT NULL,
  source_row    INT UNSIGNED    NOT NULL,       -- Excel's own row number
  -- The party exactly as the balance sheet wrote it. Spellings are grouped for
  -- display, never rewritten here: what the sheet said is what is stored.
  party_name    VARCHAR(255)    NOT NULL,
  amount        DECIMAL(14,2)   NOT NULL,
  created_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_sfrc_file FOREIGN KEY (sales_file_id)
    REFERENCES sales_files(id) ON DELETE CASCADE,

  UNIQUE KEY uq_sfrc_source (sales_file_id, source_row),
  INDEX      idx_sfrc_party (party_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The workbook's own stated total, kept beside the lines behind it so the two
-- can be compared instead of one being assumed from the other.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sales_files'
      AND column_name = 'stated_total') = 0,
  'ALTER TABLE sales_files ADD COLUMN stated_total DECIMAL(14,2) NULL AFTER closing_balance',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sales_files'
      AND column_name = 'receivable_discrepancy') = 0,
  'ALTER TABLE sales_files ADD COLUMN receivable_discrepancy DECIMAL(14,2) NULL AFTER stated_total',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ACCOUNTS is a fourth sheet shape: a month-end balance sheet, neither a sales
-- register nor a party ledger.
SET @sql := IF(
  (SELECT LOCATE('ACCOUNTS', COLUMN_TYPE) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sales_files'
      AND column_name = 'sheet_shape') = 0,
  "ALTER TABLE sales_files MODIFY COLUMN sheet_shape
     ENUM('SALES_REGISTER','PARTY_LEDGER','ACCOUNTS','SUPPLIER_STATEMENT','UNRECOGNISED')
     NOT NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
