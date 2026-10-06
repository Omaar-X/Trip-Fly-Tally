-- ============================================================================
--  D006 · CUMULATIVE-SHEET PERIOD SCOPING
--  Apply once after 016_d005_unidentified_receipt_method.sql.
--
--  Re-runnable: the ALTER goes through an information_schema check, so a
--  second run is a no-op.
-- ============================================================================

-- The day-book workbooks are cumulative. `Daily Statement NOV'24` carries 179
-- October-dated rows, `Daily Statement OCT'24` carries 80 November-dated ones,
-- and `JUN-25` repeats 80 May-2025 rows. `natural_key` includes the sheet
-- name, so the same transaction arriving from two sheets never collided and
-- posted twice — BDT 39,167,396.76 across 341 pairs.
--
-- A transaction belongs to the accounting period of its own transaction date.
-- A carry-over line whose twin genuinely exists in that month's own source is
-- staged with complete lineage and creates no second voucher. This status is
-- how such a row says so; it is NOT a deletion, and it is NOT the same thing
-- as SKIPPED_DUPLICATE, which means one sheet listed a transaction twice.

SET @sql := IF(
  (SELECT LOCATE('SKIPPED_CUMULATIVE_DUPLICATE', COLUMN_TYPE) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'migration_source_rows'
      AND column_name = 'status') = 0,
  "ALTER TABLE migration_source_rows MODIFY COLUMN status
     ENUM('PENDING','IMPORTED','SKIPPED_DUPLICATE','SKIPPED_CUMULATIVE_DUPLICATE',
          'REVIEW_REQUIRED','FAILED')
     NOT NULL DEFAULT 'PENDING'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
