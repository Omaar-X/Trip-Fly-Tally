-- ============================================================================
--  022 - NON-TRANSACTION ROWS IN THE SALES FILE ARCHIVE
--  Apply once after 021_sales_file_receivables.sql.
--
--  Re-runnable: the ALTER goes through an information_schema check.
-- ============================================================================
--
--  The monthly registers add themselves up at the foot, and the importer was
--  reading that line as a sale. On most sheets the total equals the detail
--  above it exactly, so every month's sales came out roughly DOUBLE:
--  246,538,349.81 billed across the archive against a true 148,596,313.71.
--
--  These rows arrive in three disguises, and all three are now classified
--  NON_TRANSACTION and excluded from every total:
--
--    * a SUBTOTAL()/SUM() formula over a range   (Jul-2026 row 281)
--    * a row labelled TOTAL or GRAND TOTAL
--    * a bare amount with no date, no ticket, no passenger and no client
--      (Jan-2025 row 143 carries 11,501,735.79 - exactly half that sheet)
--
--  The same defect bit the migration engine's day books, where the total rows
--  at least had labels - DEFERRED_ITEMS J6. Here they mostly do not.
--
--  The rows are kept, not deleted: an archive that quietly dropped a line
--  could not prove it had read the sheet correctly.
-- ============================================================================

SET @sql := IF(
  (SELECT LOCATE('NON_TRANSACTION', COLUMN_TYPE) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sales_file_rows'
      AND column_name = 'row_type') = 0,
  "ALTER TABLE sales_file_rows MODIFY COLUMN row_type
     ENUM('TICKET','PAYMENT','OPENING','NON_TRANSACTION','OTHER') NOT NULL",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
