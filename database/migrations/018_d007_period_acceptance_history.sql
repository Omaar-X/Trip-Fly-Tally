-- ============================================================================
--  D007 · CEO PERIOD ACCEPTANCE — HISTORY AND SNAPSHOT
--  Apply once after 017_d006_cumulative_sheet_scoping.sql.
--
--  Re-runnable: every ALTER goes through an information_schema check and the
--  CREATE is IF NOT EXISTS, so a second run is a no-op.
--
--  This migration PREPARES the acceptance path. It approves nothing.
-- ============================================================================

-- ─── 1 · A period accepted with a limitation is not a verified period ───────
--
--  `approval_outcome` already separates ACCEPTED_HISTORICAL_DATA_LIMITATION
--  from VERIFIED_MIGRATED, but the batch's own `status` still read VERIFIED
--  for both — so the headline status of an eight-month-incomplete period
--  claimed verification it does not have.
--
--  CEO acceptance means "the known historical limitation has been reviewed and
--  accepted". It must never read as "the accounting figures reconcile".

SET @sql := IF(
  (SELECT LOCATE('ACCEPTED_WITH_LIMITATION', COLUMN_TYPE) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'migration_batches'
      AND column_name = 'status') = 0,
  "ALTER TABLE migration_batches MODIFY COLUMN status
     ENUM('DRY_RUN','RUNNING','COMPLETED','FAILED','ROLLED_BACK','VERIFIED',
          'ACCEPTED_WITH_LIMITATION')
     NOT NULL DEFAULT 'DRY_RUN'",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- ─── 2 · Append-only approval history ───────────────────────────────────────
--
--  The batch row holds the CURRENT acceptance. This table holds every one that
--  has ever been made, plus every reopening, so a period whose missing source
--  turns up later can be reopened and re-accepted WITHOUT overwriting the
--  record of what was accepted before, on what figures, and by whom.
--
--  The reconciliation snapshot columns are the point of the table. Source AR,
--  migrated AR, the difference and the rest are stored AS THEY STOOD at the
--  moment of acceptance — because a later re-post changes
--  `migration_reconciliations`, and the question "what did the CEO actually
--  sign off?" must remain answerable afterwards.
--
--  Nothing here is an accounting entry. The BDT 54,324,452.20 outstanding gap
--  across the eight incomplete periods is a reconciliation difference, not a
--  journal amount, and it is recorded here rather than posted anywhere.

CREATE TABLE IF NOT EXISTS migration_period_approvals (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  company_id              INT UNSIGNED NOT NULL,
  batch_id                BIGINT UNSIGNED NOT NULL,
  source_period           CHAR(7) NOT NULL,
  action                  ENUM('ACCEPTED_HISTORICAL_DATA_LIMITATION','VERIFIED_MIGRATED','REOPENED')
                            NOT NULL,
  reason                  VARCHAR(1000) NOT NULL,
  comment                 VARCHAR(1000) NULL,

  -- What the books and the source said at this moment. Never recomputed.
  data_completeness       ENUM('COMPLETE','INCOMPLETE','REVIEW_REQUIRED') NOT NULL,
  reconciliation_status   ENUM('NOT_RUN','MATCHED','MISMATCHED') NOT NULL,
  completeness_note       VARCHAR(1000) NULL,
  source_receivable       DECIMAL(16,2) NULL,
  migrated_receivable     DECIMAL(16,2) NULL,
  receivable_difference   DECIMAL(16,2) NULL,
  source_payable          DECIMAL(16,2) NULL,
  migrated_payable        DECIMAL(16,2) NULL,
  payable_difference      DECIMAL(16,2) NULL,
  open_review_items       INT UNSIGNED NOT NULL DEFAULT 0,
  material_review_items   INT UNSIGNED NOT NULL DEFAULT 0,
  material_review_amount  DECIMAL(16,2) NOT NULL DEFAULT 0.00,

  actor_id                INT UNSIGNED NOT NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mpa_period (company_id, source_period, id),
  KEY idx_mpa_batch (batch_id),
  CONSTRAINT fk_mpa_company FOREIGN KEY (company_id) REFERENCES companies (id) ON DELETE CASCADE,
  CONSTRAINT fk_mpa_actor FOREIGN KEY (actor_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Deliberately NO foreign key from batch_id to migration_batches: the history
-- must outlive a batch that is rolled back and re-posted, which is exactly the
-- reopening case this table exists to record.

-- ─── 3 · Reopening ──────────────────────────────────────────────────────────
--
--  Set when an accepted period is reopened because authoritative source data
--  turned up. The prior acceptance stays in the history table; this only says
--  the period is open for a controlled re-post again.

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'migration_batches'
      AND column_name = 'reopened_at') = 0,
  "ALTER TABLE migration_batches
     ADD COLUMN reopened_at DATETIME NULL AFTER unresolved_at_approval,
     ADD COLUMN reopened_by INT UNSIGNED NULL AFTER reopened_at,
     ADD COLUMN reopen_reason VARCHAR(1000) NULL AFTER reopened_by",
  'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
