-- ============================================================================
--  HISTORICAL CLEARING LEDGERS · REVIEW MATERIALITY · DATA COMPLETENESS
--  Apply once after 012_historical_chart_of_accounts.sql.
--
--  Implements the five business decisions confirmed after the first Phase 4
--  staging run. Re-runnable: every INSERT is guarded, every ALTER is applied
--  through a check so a second run is a no-op. ASCII names only.
-- ============================================================================

-- ─── 1 · Unknown / Unassigned Ticket Supplier (Decision 1) ──────────────────
--
--  ONE controlled clearing payable, not 867 invented vendor masters.
--
--  Trip Fly issues through several channels — HAZEE, NDC, GDS, Sabre and
--  others — so a blank Issuing Agency does NOT mean HAZEE. Where the cost is
--  supported by the source but the supplier is not, the cost is preserved and
--  the payable side parks here until evidence names the real supplier.
--
--  is_system = 1: this is machinery, not a party someone should rename or
--  delete. It sits under Sundry Creditors because that is what it is — a
--  payable the company owes to a supplier it has not yet identified.

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Unknown / Unassigned Ticket Supplier', 0.00, 'CR', 1
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Sundry Creditors'
 WHERE NOT EXISTS (
   SELECT 1 FROM ledgers x
    WHERE x.company_id = c.id AND x.name = 'Unknown / Unassigned Ticket Supplier');

-- ─── 2 · Unclassified Historical Expense (Decision 2) ───────────────────────
--
--  A named holding account, deliberately NOT "Office Expense" or
--  "Miscellaneous". Dumping unclear items into a plausible-looking expense
--  ledger would clear the review flags and destroy the question.
--
--  The original narration stays on the voucher and on the source row, so it
--  remains searchable after classification.

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Unclassified Historical Expense', 0.00, 'DR', 1
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Indirect Expenses'
 WHERE NOT EXISTS (
   SELECT 1 FROM ledgers x
    WHERE x.company_id = c.id AND x.name = 'Unclassified Historical Expense');

-- ─── 3 · Review items: materiality and CEO acceptance (Decision 5) ──────────
--
--  Not every historical ambiguity is worth a person's time, and the client was
--  explicit that finalisation must not wait for all 2,000 of them. These
--  columns are what let the queue be triaged rather than merely counted.
--
--  CEO acceptance is a THIRD state, not a resolution: the item stays, its
--  evidence stays, and it is visibly "accepted as an unresolved historical
--  limitation" rather than "fixed". `ACCEPTED_AS_IS` already existed for a
--  human resolution; CEO_ACCEPTED is different and needs its own value.

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'migration_review_items'
      AND column_name = 'is_material') = 0,
  'ALTER TABLE migration_review_items
     ADD COLUMN is_material TINYINT(1) NOT NULL DEFAULT 0 AFTER issue_type,
     ADD COLUMN impact_amount DECIMAL(14,2) NULL AFTER is_material,
     ADD COLUMN ceo_accepted_by INT UNSIGNED NULL,
     ADD COLUMN ceo_accepted_at DATETIME NULL,
     ADD COLUMN ceo_accept_reason VARCHAR(1000) NULL,
     ADD INDEX idx_mri_material (company_id, is_material, status)',
  'SELECT "migration_review_items already extended"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

--  The status enum gains CEO_ACCEPTED. Stated in full because MODIFY replaces
--  the whole definition.
ALTER TABLE migration_review_items
  MODIFY COLUMN status ENUM('OPEN','RESOLVED','ACCEPTED_AS_IS','WONT_FIX','CEO_ACCEPTED')
    NOT NULL DEFAULT 'OPEN';

-- ─── 4 · Batch: the four statuses kept apart (Decisions 3 and 4) ────────────
--
--  A balanced trial balance proves double-entry integrity and says nothing
--  about whether the history reconciles. Collapsing the two into one status is
--  how a migration comes to look finished when it is not, so they are four
--  separate columns:
--
--    accounting_integrity   DR = CR
--    reconciliation_status  source vs migrated        (already present, 009)
--    data_completeness      COMPLETE / INCOMPLETE / REVIEW_REQUIRED
--    ceo_approval_status    PENDING / APPROVED        (already present, 009)

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'migration_batches'
      AND column_name = 'data_completeness') = 0,
  'ALTER TABLE migration_batches
     ADD COLUMN data_completeness ENUM("COMPLETE","INCOMPLETE","REVIEW_REQUIRED")
       NOT NULL DEFAULT "REVIEW_REQUIRED" AFTER reconciliation_status,
     ADD COLUMN completeness_note VARCHAR(1000) NULL AFTER data_completeness,
     ADD COLUMN accounting_integrity ENUM("BALANCED","UNBALANCED","NOT_CHECKED")
       NOT NULL DEFAULT "NOT_CHECKED" AFTER completeness_note',
  'SELECT "migration_batches already extended"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ─── 5 · Supplier reclassification trail (Decision 1) ───────────────────────
--
--  When evidence later names the real supplier, the payable moves — and the
--  move is itself a recorded, audited event. The original posting and the
--  original cost are never edited: "Do not change historical Cost simply
--  because supplier is later identified."

CREATE TABLE IF NOT EXISTS historical_supplier_reclassifications (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED    NOT NULL,
  source_row_id  BIGINT UNSIGNED NOT NULL,
  voucher_id     BIGINT UNSIGNED NULL,

  from_ledger_id INT UNSIGNED    NOT NULL,
  to_ledger_id   INT UNSIGNED    NOT NULL,
  amount         DECIMAL(14,2)   NOT NULL,

  -- Why the new supplier is believed to be the right one. NOT NULL: a
  -- reclassification without evidence is a guess with a timestamp.
  evidence       VARCHAR(1000)   NOT NULL,
  reason         VARCHAR(1000)   NOT NULL,

  actor_id       INT UNSIGNED    NOT NULL,
  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_hsr_company FOREIGN KEY (company_id)    REFERENCES companies(id),
  CONSTRAINT fk_hsr_row     FOREIGN KEY (source_row_id) REFERENCES migration_source_rows(id) ON DELETE CASCADE,
  CONSTRAINT fk_hsr_voucher FOREIGN KEY (voucher_id)    REFERENCES vouchers(id) ON DELETE SET NULL,
  CONSTRAINT fk_hsr_from    FOREIGN KEY (from_ledger_id) REFERENCES ledgers(id),
  CONSTRAINT fk_hsr_to      FOREIGN KEY (to_ledger_id)   REFERENCES ledgers(id),
  CONSTRAINT fk_hsr_actor   FOREIGN KEY (actor_id)       REFERENCES users(id),

  INDEX idx_hsr_row (source_row_id)
) ENGINE=InnoDB;

-- ─── 6 · Suspense breakdown needs the category on the row ───────────────────
--
--  "I want to know WHY the unexplained amount exists, not just its total."
--  Storing the clearing category on the source row is what lets the breakdown
--  be a query rather than a reconstruction.

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'migration_source_rows'
      AND column_name = 'clearing_category') = 0,
  'ALTER TABLE migration_source_rows
     ADD COLUMN clearing_category VARCHAR(60) NULL AFTER status,
     ADD COLUMN clearing_amount DECIMAL(14,2) NULL AFTER clearing_category,
     ADD INDEX idx_msr_clearing (company_id, clearing_category)',
  'SELECT "migration_source_rows already extended"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
