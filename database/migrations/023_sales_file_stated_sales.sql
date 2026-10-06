-- ============================================================================
--  023 - THE SALES FIGURE THE BALANCE SHEET STATES
--  Apply once after 022_sales_file_row_non_transaction.sql.
--
--  Re-runnable: the ALTER goes through an information_schema check.
-- ============================================================================
--
--  The dashboard's sales card used to show the sum of the month register's own
--  rows. That is a derived number, and it does not match what the office wrote
--  on the balance sheet: for July-2026 they state 19,113,906 where the rows add
--  to 19,352,631.
--
--  Part of the 238,725 gap is explainable - ADM and void penalties in that
--  month come to exactly 61,080, which is the `VOID & ADM` line in their
--  expenses, so those are not sales to them - and part of it is not.
--
--  So the card now shows THEIR figure, the same way the receivable card shows
--  their ACCOUNTS RECEIVABLE total, and the computed sum rides alongside as a
--  cross-check. Note the cell is a typed number on every workbook, never a
--  formula: it is what somebody decided the month's sales were.
-- ============================================================================

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sales_files'
      AND column_name = 'stated_sales') = 0,
  'ALTER TABLE sales_files ADD COLUMN stated_sales DECIMAL(14,2) NULL AFTER stated_total',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
