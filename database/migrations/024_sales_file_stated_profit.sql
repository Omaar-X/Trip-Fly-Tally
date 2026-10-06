-- ============================================================================
--  024 - THE BOTTOM LINE THE BALANCE SHEET STATES
--  Apply once after 023_sales_file_stated_sales.sql.
--
--  Re-runnable: the ALTERs go through an information_schema check.
-- ============================================================================
--
--  Every ACCOUNTS sheet in the archive states a result for the month -
--  eighteen a NET PROFIT and fifteen a NET LOSS - and none of it was being
--  read. The dashboard's "Net Profit (YTD)" card comes from the posted
--  ledgers and correctly reads 0.00, because this archive posts nothing; the
--  office's own figure had nowhere to appear.
--
--  Profit and loss are stored SEPARATELY rather than as one signed number,
--  because July-2026 states both: 2,270,737.22 on the capital side and a typed
--  `=-2315414` on the other. A balance sheet that disagrees with itself is
--  worth showing, not averaging.
-- ============================================================================

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sales_files'
      AND column_name = 'stated_profit') = 0,
  'ALTER TABLE sales_files ADD COLUMN stated_profit DECIMAL(14,2) NULL AFTER stated_sales',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sales_files'
      AND column_name = 'stated_loss') = 0,
  'ALTER TABLE sales_files ADD COLUMN stated_loss DECIMAL(14,2) NULL AFTER stated_profit',
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
