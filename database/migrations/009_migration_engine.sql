-- ============================================================================
--  MIGRATION ENGINE
--  Apply once after 008_party_master_dedup.sql.
--
--  Phase 3 builds the machinery, not the migration. Nothing here imports a
--  single historical row; it is the batch record, the source-to-target trail,
--  the review queue and the reconciliation ledger that the Phase 4 import will
--  run inside.
--
--  The governing rule, from the client: every migrated transaction must be
--  traceable back to its source, and no total may ever be forced. Both are
--  structural here rather than conventions a script is trusted to follow —
--  migration_source_rows cannot be written without naming a file, sheet and
--  row, and an adjustment cannot be written without a reason and a batch.
-- ============================================================================

-- migration_batches ─── one row per import run ──────────────────────────────
--  A batch is the unit of atomicity. It is created BEFORE any data is written,
--  carries the snapshot taken at that moment, and ends either COMPLETED or
--  ROLLED_BACK — never half-applied.
CREATE TABLE IF NOT EXISTS migration_batches (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED    NOT NULL,
  batch_no       VARCHAR(30)     NOT NULL,          -- MIG-2026-00001
  source_period  CHAR(7)         NOT NULL,          -- '2024-03'; one month per batch
  description    VARCHAR(255)    NULL,

  --  DRY_RUN     parsed and reconciled, nothing written — the default first pass
  --  RUNNING     writing; a batch left in this state means the process died
  --  COMPLETED   all rows written, reconciliation generated
  --  FAILED      aborted mid-way; rollback_status says what happened next
  --  ROLLED_BACK every row of this batch removed
  --  VERIFIED    reconciled AND finally approved by the CEO (see §26)
  status         ENUM('DRY_RUN','RUNNING','COMPLETED','FAILED','ROLLED_BACK','VERIFIED')
                                 NOT NULL DEFAULT 'DRY_RUN',

  -- Where the pre-batch backup lives. Text rather than a foreign key: the
  -- snapshot is a file or a managed-database restore point, outside this DB.
  snapshot_ref   VARCHAR(255)    NULL,
  snapshot_taken_at DATETIME     NULL,

  started_at     DATETIME        NULL,
  completed_at   DATETIME        NULL,

  -- {"sales":142,"receipts":31,"skipped":4,...} — what the run actually did,
  -- kept as counts so a reconciliation can be re-read without replaying.
  imported_counts JSON           NULL,
  error_details  TEXT            NULL,

  rollback_status ENUM('NONE','REQUESTED','DONE','FAILED') NOT NULL DEFAULT 'NONE',
  rolled_back_at DATETIME        NULL,
  rolled_back_by INT UNSIGNED    NULL,

  reconciliation_status ENUM('NOT_RUN','MATCHED','MISMATCHED') NOT NULL DEFAULT 'NOT_RUN',

  --  A month becomes VERIFIED only on CEO final approval. The CEO may approve
  --  with REVIEW_REQUIRED items still open, but then the reason is mandatory
  --  and the open items stay visible — hence both columns, not a bare flag.
  ceo_approval_status ENUM('NOT_REQUESTED','PENDING','APPROVED','REJECTED')
                                 NOT NULL DEFAULT 'NOT_REQUESTED',
  approved_by    INT UNSIGNED    NULL,
  approved_at    DATETIME        NULL,
  approval_reason VARCHAR(1000)  NULL,
  unresolved_at_approval INT UNSIGNED NOT NULL DEFAULT 0,

  created_by     INT UNSIGNED    NOT NULL,
  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_mb_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_mb_creator  FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_mb_approver FOREIGN KEY (approved_by) REFERENCES users(id),
  CONSTRAINT fk_mb_rollback FOREIGN KEY (rolled_back_by) REFERENCES users(id),

  UNIQUE KEY uq_batch_no      (company_id, batch_no),
  INDEX      idx_mb_period    (company_id, source_period),
  INDEX      idx_mb_status    (company_id, status)
) ENGINE=InnoDB;

-- migration_source_rows ─── the audit trail from spreadsheet to voucher ─────
--  One row per source line the engine looked at, whether it imported, skipped
--  or parked it. This is what makes "where did this voucher come from" a
--  question with an answer.
--
--  natural_key is what makes a re-run idempotent. It is composed by the engine
--  from whatever identifies the row in its own source — ticket number plus
--  date plus amount for a sale, date plus name plus amount plus direction for
--  a cash row — and is unique per company. A second run recognises the key and
--  skips, rather than posting the transaction twice.
CREATE TABLE IF NOT EXISTS migration_source_rows (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED    NOT NULL,
  batch_id       BIGINT UNSIGNED NOT NULL,

  -- Provenance. All three are NOT NULL: a row that cannot say where it came
  -- from has no business being in the books.
  source_file    VARCHAR(255)    NOT NULL,
  source_sheet   VARCHAR(120)    NOT NULL,
  source_row     INT UNSIGNED    NOT NULL,
  source_period  CHAR(7)         NOT NULL,

  -- What the source called the transaction, kept verbatim.
  source_ref     VARCHAR(120)    NULL,   -- ticket number / voucher ref
  pnr            VARCHAR(40)     NULL,   -- several rows may share one PNR (§5)
  source_date    DATE            NULL,
  source_amount  DECIMAL(14,2)   NULL,
  source_classification VARCHAR(120) NULL,  -- the sheet's own category wording
  service_category ENUM('AIR_TICKET','VISA','TOUR','HOTEL','HAJJ_UMRAH','OTHER','REVIEW_REQUIRED')
                                 NOT NULL DEFAULT 'REVIEW_REQUIRED',

  -- Party as written, and party as resolved. Both kept: the original is
  -- evidence, the normalised one is the link.
  original_party_name VARCHAR(200) NULL,
  party_type     ENUM('CUSTOMER','SUPPLIER','AGENT','EMPLOYEE','BANK','LOAN','GL','NONE','REVIEW_REQUIRED')
                                 NOT NULL DEFAULT 'REVIEW_REQUIRED',
  party_id       INT UNSIGNED    NULL,
  normalized_party_name VARCHAR(200) NULL,

  -- Where it landed, once it did.
  target_entity  VARCHAR(40)     NULL,   -- 'vouchers' | 'payments' | 'invoices' | …
  target_id      BIGINT UNSIGNED NULL,

  status         ENUM('PENDING','IMPORTED','SKIPPED_DUPLICATE','REVIEW_REQUIRED','FAILED')
                                 NOT NULL DEFAULT 'PENDING',
  natural_key    VARCHAR(190)    NOT NULL,
  note           VARCHAR(500)    NULL,
  raw            JSON            NULL,   -- the whole source row, as read

  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_msr_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_msr_batch   FOREIGN KEY (batch_id)   REFERENCES migration_batches(id) ON DELETE CASCADE,

  -- The idempotency guarantee. A re-run cannot double-post what it already did.
  UNIQUE KEY uq_msr_natural (company_id, natural_key),
  INDEX      idx_msr_batch  (batch_id, status),
  INDEX      idx_msr_target (target_entity, target_id),
  INDEX      idx_msr_pnr    (company_id, pnr),           -- §5: filter by PNR
  INDEX      idx_msr_period (company_id, source_period),
  INDEX      idx_msr_party  (company_id, party_type, party_id)
) ENGINE=InnoDB;

-- migration_review_items ─── the REVIEW_REQUIRED queue ──────────────────────
--  Ambiguous financial rows are never silently discarded. They land here with
--  what the engine could work out and what it could not.
CREATE TABLE IF NOT EXISTS migration_review_items (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED    NOT NULL,
  batch_id       BIGINT UNSIGNED NULL,          -- NULL for rules-level findings
  source_row_id  BIGINT UNSIGNED NULL,

  module         VARCHAR(40)     NOT NULL,      -- 'SALES' | 'PARTY' | 'PAYMENT' | …
  issue_type     VARCHAR(60)     NOT NULL,      -- 'AMBIGUOUS_PARTY' | 'PAYMENT_METHOD_UNKNOWN' | …
  source_ref     VARCHAR(255)    NULL,          -- file · sheet · row, human readable
  issue          VARCHAR(1000)   NOT NULL,
  proposed       VARCHAR(1000)   NULL,          -- best guess, offered not applied

  status         ENUM('OPEN','RESOLVED','ACCEPTED_AS_IS','WONT_FIX') NOT NULL DEFAULT 'OPEN',
  resolution     VARCHAR(1000)   NULL,
  resolved_by    INT UNSIGNED    NULL,
  resolved_at    DATETIME        NULL,
  notes          VARCHAR(1000)   NULL,

  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_mri_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_mri_batch   FOREIGN KEY (batch_id)   REFERENCES migration_batches(id) ON DELETE CASCADE,
  CONSTRAINT fk_mri_row     FOREIGN KEY (source_row_id) REFERENCES migration_source_rows(id) ON DELETE SET NULL,
  CONSTRAINT fk_mri_user    FOREIGN KEY (resolved_by) REFERENCES users(id),

  INDEX idx_mri_status (company_id, status, module),
  INDEX idx_mri_batch  (batch_id, status)
) ENGINE=InnoDB;

-- migration_reconciliations ─── source vs migrated, per metric ──────────────
--  Generated after each batch. The source value comes from the client's own
--  month-end sheet; the migrated value is computed from what actually posted.
--  A mismatch is recorded, never corrected away.
CREATE TABLE IF NOT EXISTS migration_reconciliations (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED    NOT NULL,
  batch_id       BIGINT UNSIGNED NOT NULL,
  source_period  CHAR(7)         NOT NULL,

  metric         ENUM('SALES','PURCHASE','RECEIPT','PAYMENT','CUSTOMER_OUTSTANDING',
                      'VENDOR_PAYABLE','EXPENSES','PROFIT_LOSS','CAPITAL','FIXED_ASSETS',
                      'TRANSACTION_COUNT','REVIEW_REQUIRED_COUNT')
                                 NOT NULL,
  source_value   DECIMAL(16,2)   NULL,          -- NULL when the sheet has no such figure
  migrated_value DECIMAL(16,2)   NOT NULL DEFAULT 0.00,
  difference     DECIMAL(16,2)   AS (COALESCE(migrated_value,0) - COALESCE(source_value,0)) STORED,
  source_note    VARCHAR(255)    NULL,          -- which sheet the control value came from
  status         ENUM('MATCHED','MISMATCHED','NO_SOURCE') NOT NULL DEFAULT 'NO_SOURCE',

  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_mrec_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_mrec_batch   FOREIGN KEY (batch_id)   REFERENCES migration_batches(id) ON DELETE CASCADE,

  UNIQUE KEY uq_mrec (batch_id, metric),
  INDEX      idx_mrec_status (company_id, status)
) ENGINE=InnoDB;

-- historical_outstanding_adjustments ─── the last resort, fully audited ─────
--  Only reachable after the investigation the client mandated has failed to
--  explain a difference. Every column here exists so the adjustment can be
--  argued with later: what the authoritative file said, what the books
--  computed, the gap, why it was accepted, and which voucher carries it.
--
--  There is deliberately no path that writes this table silently — reason and
--  approved_by are NOT NULL.
CREATE TABLE IF NOT EXISTS historical_outstanding_adjustments (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED    NOT NULL,
  batch_id       BIGINT UNSIGNED NOT NULL,

  party_type     ENUM('CUSTOMER','SUPPLIER') NOT NULL,
  party_id       INT UNSIGNED    NOT NULL,

  control_amount    DECIMAL(14,2) NOT NULL,     -- the authoritative file's figure
  calculated_amount DECIMAL(14,2) NOT NULL,     -- what the migrated books produced
  difference        DECIMAL(14,2) AS (control_amount - calculated_amount) STORED,

  control_source VARCHAR(255)    NOT NULL,      -- which file/sheet is authoritative
  investigation  VARCHAR(1000)   NOT NULL,      -- what was searched before giving up
  reason         VARCHAR(1000)   NOT NULL,

  voucher_id     BIGINT UNSIGNED NULL,          -- the journal that carries it
  approved_by    INT UNSIGNED    NOT NULL,
  approved_at    DATETIME        NOT NULL,

  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_hoa_company  FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_hoa_batch    FOREIGN KEY (batch_id)   REFERENCES migration_batches(id),
  CONSTRAINT fk_hoa_voucher  FOREIGN KEY (voucher_id) REFERENCES vouchers(id),
  CONSTRAINT fk_hoa_approver FOREIGN KEY (approved_by) REFERENCES users(id),

  INDEX idx_hoa_party (company_id, party_type, party_id),
  INDEX idx_hoa_batch (batch_id)
) ENGINE=InnoDB;

-- agents ─── who introduced the business (§1) ───────────────────────────────
--  The historical REFFERENCE column names the person a booking came through.
--  That is a source/reference relationship, not a debt: mapping it to a
--  customer would have opened a 718-row receivable against the company's own
--  CEO.
--
--  An agent is NOT a commission liability. Commission is created only where
--  the source carries an explicit commission amount — hence no rate column
--  here, deliberately.
CREATE TABLE IF NOT EXISTS agents (
  id           INT UNSIGNED     AUTO_INCREMENT PRIMARY KEY,
  company_id   INT UNSIGNED     NOT NULL,
  name         VARCHAR(150)     NOT NULL,
  name_key     VARCHAR(150)     AS (UPPER(TRIM(REGEXP_REPLACE(name, '[[:space:]]+', ' ')))) STORED,
  -- Set when the agent is also a person on the payroll, as the CEO is.
  employee_id  INT UNSIGNED     NULL,
  -- Set when the agent also trades on their own account, so the two identities
  -- stay linked without being merged.
  customer_id  INT UNSIGNED     NULL,
  phone        VARCHAR(30)      NULL,
  note         VARCHAR(500)     NULL,
  is_active    TINYINT(1)       NOT NULL DEFAULT 1,
  created_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_ag_company  FOREIGN KEY (company_id)  REFERENCES companies(id),
  CONSTRAINT fk_ag_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
  CONSTRAINT fk_ag_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,

  UNIQUE KEY uq_agent_name (company_id, name_key),
  INDEX      idx_ag_active (company_id, is_active),
  INDEX      idx_ag_name   (company_id, name)
) ENGINE=InnoDB;

-- Bookings already carry agent_id pointing at employees. Agent-wise reporting
-- needs the reference party even when they are not staff, so the link is added
-- alongside rather than replacing it.
ALTER TABLE bookings
  ADD COLUMN reference_agent_id INT UNSIGNED NULL AFTER agent_id,
  ADD CONSTRAINT fk_b_ref_agent FOREIGN KEY (reference_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
  ADD INDEX idx_b_ref_agent (company_id, reference_agent_id);

-- Invoices and vouchers gain the same link so Sales, Revenue, Cost and P&L can
-- all be sliced by reference without joining back through bookings, which not
-- every historical row will have.
ALTER TABLE invoices
  ADD COLUMN reference_agent_id INT UNSIGNED NULL AFTER booking_id,
  ADD CONSTRAINT fk_inv_ref_agent FOREIGN KEY (reference_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
  ADD INDEX idx_inv_ref_agent (company_id, reference_agent_id);

-- Migrated vouchers point back at the source row that produced them, which is
-- the other half of the traceability requirement.
ALTER TABLE vouchers
  ADD COLUMN migration_batch_id BIGINT UNSIGNED NULL AFTER created_by,
  ADD CONSTRAINT fk_v_mig_batch FOREIGN KEY (migration_batch_id) REFERENCES migration_batches(id),
  ADD INDEX idx_v_mig_batch (migration_batch_id);
