-- ============================================================================
--  EDIT / DELETE APPROVAL · BACKDATED ACCESS · AUDIT FOUNDATION
--  Apply once after 009_migration_engine.sql.
--
--  Two workflows that look similar and are deliberately not the same table:
--
--    change_requests            asking to CHANGE something that already exists.
--                               CEO is final authority; an authorised Admin can
--                               only recommend.
--    backdated_access_requests  asking for permission to CREATE something dated
--                               in the past. CEO *or* an authorised Admin can
--                               finally approve — no second signature.
--
--  Merging them would have meant one status machine pretending to be two, and
--  the difference above is exactly the kind of thing that gets lost when it
--  lives in an if-statement instead of a schema.
-- ============================================================================

-- ─── configurable settings ──────────────────────────────────────────────────

ALTER TABLE companies
  --  How long after a backdated-access window closes a save may still land.
  --  Someone who started a legitimate entry at 3:29 should not lose it because
  --  the approval lapsed at 3:30 while they were typing.
  ADD COLUMN bdr_grace_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 10
    AFTER back_entry_grace_days;

-- ─── change requests: EDT-YYYY-00001 / DEL-YYYY-00001 ───────────────────────

CREATE TABLE IF NOT EXISTS change_requests (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED    NOT NULL,
  request_no     VARCHAR(30)     NOT NULL,          -- EDT-2026-00001 / DEL-2026-00001
  kind           ENUM('EDIT','DELETE') NOT NULL,

  entity         VARCHAR(40)     NOT NULL,          -- 'vouchers' | 'payments' | 'bookings' | …
  entity_id      BIGINT UNSIGNED NOT NULL,
  --  Financial rows stay ACTIVE until final approval and are only ever soft
  --  deleted. Non-financial rows may execute under an approved one-time
  --  permission. The engine must not have to infer which it is.
  is_financial   TINYINT(1)      NOT NULL DEFAULT 1,

  --  PENDING           waiting on a decision
  --  NEEDS_CORRECTION  CEO asked for changes; requester still owns it
  --  RESUBMITTED       requester answered; a new version of the same request
  --  ADMIN_REVIEWED    an authorised Admin recommended; CEO still decides
  --  APPROVED          effective
  --  REJECTED          requester may correct and resubmit the same request
  --  CANCELLED         withdrawn by the requester before any final decision
  status         ENUM('PENDING','NEEDS_CORRECTION','RESUBMITTED','ADMIN_REVIEWED',
                      'APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  priority       ENUM('LOW','NORMAL','HIGH','URGENT') NOT NULL DEFAULT 'NORMAL',

  reason         VARCHAR(1000)   NOT NULL,          -- mandatory, both kinds
  description    VARCHAR(2000)   NULL,

  --  original_values is captured when the request is raised, not when it is
  --  approved: the point of a before/after log is that "before" is the state
  --  the requester actually looked at.
  original_values JSON           NULL,
  proposed_values JSON           NULL,              -- NULL for a delete
  final_values    JSON           NULL,              -- what was actually applied

  requested_by   INT UNSIGNED    NOT NULL,
  requested_role VARCHAR(40)     NOT NULL,

  --  Admin review is a recommendation and is never mandatory; the CEO may
  --  bypass it entirely. Kept separate from the CEO columns so a bypass is
  --  visible as an absence rather than guessed at.
  admin_recommendation ENUM('APPROVE','REJECT','NEEDS_CORRECTION') NULL,
  admin_reviewed_by INT UNSIGNED NULL,
  admin_reviewed_at DATETIME     NULL,
  admin_note     VARCHAR(1000)   NULL,

  decided_by     INT UNSIGNED    NULL,              -- always the CEO for these
  decided_at     DATETIME        NULL,
  decision_note  VARCHAR(1000)   NULL,

  cancel_reason  VARCHAR(500)    NULL,
  cancelled_at   DATETIME        NULL,

  --  A rejected request is corrected and resubmitted as the SAME request, so
  --  the conversation stays in one place; version counts the rounds.
  version        SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_cr_company   FOREIGN KEY (company_id)   REFERENCES companies(id),
  CONSTRAINT fk_cr_requester FOREIGN KEY (requested_by) REFERENCES users(id),
  CONSTRAINT fk_cr_admin     FOREIGN KEY (admin_reviewed_by) REFERENCES users(id),
  CONSTRAINT fk_cr_decider   FOREIGN KEY (decided_by)   REFERENCES users(id),

  UNIQUE KEY uq_cr_no       (company_id, request_no),
  INDEX      idx_cr_status  (company_id, status, priority),
  INDEX      idx_cr_entity  (company_id, entity, entity_id),
  INDEX      idx_cr_user    (requested_by, status)
) ENGINE=InnoDB;

-- Every round of a request, so "what did they ask for the first time" survives
-- a resubmission overwriting proposed_values.
CREATE TABLE IF NOT EXISTS change_request_versions (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id     BIGINT UNSIGNED NOT NULL,
  version        SMALLINT UNSIGNED NOT NULL,
  proposed_values JSON           NULL,
  reason         VARCHAR(1000)   NULL,
  submitted_by   INT UNSIGNED    NOT NULL,
  submitted_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_crv_request FOREIGN KEY (request_id) REFERENCES change_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_crv_user    FOREIGN KEY (submitted_by) REFERENCES users(id),
  UNIQUE KEY uq_crv (request_id, version)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS change_request_comments (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id   BIGINT UNSIGNED NOT NULL,
  author_id    INT UNSIGNED    NOT NULL,
  author_role  VARCHAR(40)     NOT NULL,
  body         VARCHAR(2000)   NOT NULL,
  -- Set when this comment is what moved the request to NEEDS_CORRECTION.
  moved_status VARCHAR(30)     NULL,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_crc_request FOREIGN KEY (request_id) REFERENCES change_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_crc_user    FOREIGN KEY (author_id)  REFERENCES users(id),
  INDEX idx_crc_request (request_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS change_request_attachments (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id   BIGINT UNSIGNED NOT NULL,
  file_name    VARCHAR(255)    NOT NULL,
  file_path    VARCHAR(500)    NOT NULL,
  mime_type    VARCHAR(120)    NULL,
  size_bytes   INT UNSIGNED    NULL,
  uploaded_by  INT UNSIGNED    NOT NULL,
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_cra_request FOREIGN KEY (request_id) REFERENCES change_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_cra_user    FOREIGN KEY (uploaded_by) REFERENCES users(id),
  INDEX idx_cra_request (request_id)
) ENGINE=InnoDB;

-- ─── one-time edit/delete permission ────────────────────────────────────────
--  Approving a request does not hand out a role. It hands out one use, for one
--  user, on one row. Once spent it cannot be spent again — another change
--  needs another request.
CREATE TABLE IF NOT EXISTS one_time_permissions (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id   INT UNSIGNED    NOT NULL,
  request_id   BIGINT UNSIGNED NOT NULL,
  user_id      INT UNSIGNED    NOT NULL,
  kind         ENUM('EDIT','DELETE') NOT NULL,
  entity       VARCHAR(40)     NOT NULL,
  entity_id    BIGINT UNSIGNED NOT NULL,

  granted_by   INT UNSIGNED    NOT NULL,
  granted_at   DATETIME        NOT NULL,
  expires_at   DATETIME        NULL,              -- optional wall-clock bound
  used_at      DATETIME        NULL,              -- non-NULL = spent
  revoked_at   DATETIME        NULL,

  CONSTRAINT fk_otp_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_otp_request FOREIGN KEY (request_id) REFERENCES change_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_otp_user    FOREIGN KEY (user_id)    REFERENCES users(id),
  CONSTRAINT fk_otp_grantor FOREIGN KEY (granted_by) REFERENCES users(id),

  -- One live grant per request; re-approving the same request cannot mint a second.
  UNIQUE KEY uq_otp_request (request_id),
  INDEX      idx_otp_lookup (user_id, entity, entity_id, used_at)
) ENGINE=InnoDB;

-- ─── admin approval authority (§34) ─────────────────────────────────────────
--  The CEO may let a specific Admin review requests. It is a grant on a user,
--  revocable, and both the grant and the revoke are audited.
CREATE TABLE IF NOT EXISTS admin_approval_grants (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id   INT UNSIGNED    NOT NULL,
  user_id      INT UNSIGNED    NOT NULL,
  -- CHANGE_REVIEW  may recommend on edit/delete requests (CEO still decides)
  -- BDR_APPROVE    may finally approve backdated access (no CEO signature needed)
  scope        ENUM('CHANGE_REVIEW','BDR_APPROVE') NOT NULL,
  granted_by   INT UNSIGNED    NOT NULL,
  granted_at   DATETIME        NOT NULL,
  revoked_by   INT UNSIGNED    NULL,
  revoked_at   DATETIME        NULL,
  note         VARCHAR(500)    NULL,

  CONSTRAINT fk_aag_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_aag_user    FOREIGN KEY (user_id)    REFERENCES users(id),
  CONSTRAINT fk_aag_grantor FOREIGN KEY (granted_by) REFERENCES users(id),
  CONSTRAINT fk_aag_revoker FOREIGN KEY (revoked_by) REFERENCES users(id),

  INDEX idx_aag_live (company_id, user_id, scope, revoked_at)
) ENGINE=InnoDB;

-- ─── backdated access requests: BDR-YYYY-00001 ──────────────────────────────
CREATE TABLE IF NOT EXISTS backdated_access_requests (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED    NOT NULL,
  request_no     VARCHAR(30)     NOT NULL,          -- BDR-2026-00001

  --  One module per request, by design. Wanting a second module is a second
  --  request, so an approver can never be handed a bundle they must take or
  --  leave whole.
  module         ENUM('VOUCHER','PAYMENT','BOOKING','INVOICE','INVENTORY','PAYROLL') NOT NULL,

  requested_from DATE            NOT NULL,
  requested_to   DATE            NOT NULL,
  --  What was actually granted. An approver may narrow the window but never
  --  widen it past what was asked — enforced in the service, recorded here so
  --  the difference between asked and given stays visible.
  approved_from  DATE            NULL,
  approved_to    DATE            NULL,

  reason         VARCHAR(1000)   NOT NULL,
  priority       ENUM('LOW','NORMAL','HIGH','URGENT') NOT NULL DEFAULT 'NORMAL',

  status         ENUM('PENDING','APPROVED','REJECTED','CANCELLED','REVOKED','EXPIRED')
                                 NOT NULL DEFAULT 'PENDING',

  requested_by   INT UNSIGNED    NOT NULL,
  requested_role VARCHAR(40)     NOT NULL,

  decided_by     INT UNSIGNED    NULL,              -- CEO or an authorised Admin
  decided_role   VARCHAR(40)     NULL,
  decided_at     DATETIME        NULL,
  decision_note  VARCHAR(1000)   NULL,

  --  24 hours from approval, set at approval time rather than computed on
  --  read: a later change to the rule must not silently extend access that was
  --  already granted.
  expires_at     DATETIME        NULL,

  revoked_by     INT UNSIGNED    NULL,
  revoked_at     DATETIME        NULL,
  revoke_reason  VARCHAR(500)    NULL,

  cancel_reason  VARCHAR(500)    NULL,
  cancelled_at   DATETIME        NULL,

  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_bdr_company   FOREIGN KEY (company_id)   REFERENCES companies(id),
  CONSTRAINT fk_bdr_requester FOREIGN KEY (requested_by) REFERENCES users(id),
  CONSTRAINT fk_bdr_decider   FOREIGN KEY (decided_by)   REFERENCES users(id),
  CONSTRAINT fk_bdr_revoker   FOREIGN KEY (revoked_by)   REFERENCES users(id),

  UNIQUE KEY uq_bdr_no     (company_id, request_no),
  INDEX      idx_bdr_live  (company_id, requested_by, module, status, expires_at),
  INDEX      idx_bdr_status (company_id, status, priority)
) ENGINE=InnoDB;

-- ─── notification delivery log (§35) ────────────────────────────────────────
--  Providers are configured, not hardcoded, and a missing provider must not
--  fail the request that triggered it — so delivery is recorded here and
--  SKIPPED is a normal outcome, not an error.
CREATE TABLE IF NOT EXISTS notification_log (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id   INT UNSIGNED    NOT NULL,
  channel      ENUM('DASHBOARD','EMAIL','WHATSAPP') NOT NULL,
  event        VARCHAR(60)     NOT NULL,           -- 'CHANGE_REQUEST_CREATED' | 'BDR_APPROVED' | …
  request_type ENUM('CHANGE','BDR') NULL,
  request_id   BIGINT UNSIGNED NULL,
  recipient_id INT UNSIGNED    NULL,
  recipient_addr VARCHAR(255)  NULL,
  status       ENUM('QUEUED','SENT','FAILED','SKIPPED_NOT_CONFIGURED') NOT NULL DEFAULT 'QUEUED',
  error        VARCHAR(500)    NULL,
  read_at      DATETIME        NULL,               -- dashboard channel only
  created_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_nl_company   FOREIGN KEY (company_id)   REFERENCES companies(id),
  CONSTRAINT fk_nl_recipient FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE SET NULL,

  INDEX idx_nl_inbox (company_id, recipient_id, channel, read_at),
  INDEX idx_nl_req   (request_type, request_id)
) ENGINE=InnoDB;

-- ─── soft delete + backdated flags on the transaction tables ────────────────
--  Financial rows are never hard deleted. A soft delete keeps the row, its
--  vouchers and its audit trail intact and restorable by the CEO.

ALTER TABLE bookings
  ADD COLUMN deleted_at    DATETIME     NULL,
  ADD COLUMN deleted_by    INT UNSIGNED NULL,
  ADD COLUMN delete_reason VARCHAR(500) NULL,
  ADD COLUMN restored_at   DATETIME     NULL,
  ADD COLUMN restored_by   INT UNSIGNED NULL,
  ADD COLUMN is_backdated  TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN bdr_id        BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_b_deleted_by  FOREIGN KEY (deleted_by)  REFERENCES users(id),
  ADD CONSTRAINT fk_b_restored_by FOREIGN KEY (restored_by) REFERENCES users(id),
  ADD CONSTRAINT fk_b_bdr         FOREIGN KEY (bdr_id) REFERENCES backdated_access_requests(id),
  ADD INDEX idx_b_deleted (company_id, deleted_at);

ALTER TABLE invoices
  ADD COLUMN deleted_at    DATETIME     NULL,
  ADD COLUMN deleted_by    INT UNSIGNED NULL,
  ADD COLUMN delete_reason VARCHAR(500) NULL,
  ADD COLUMN restored_at   DATETIME     NULL,
  ADD COLUMN restored_by   INT UNSIGNED NULL,
  ADD COLUMN is_backdated  TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN bdr_id        BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_inv_deleted_by  FOREIGN KEY (deleted_by)  REFERENCES users(id),
  ADD CONSTRAINT fk_inv_restored_by FOREIGN KEY (restored_by) REFERENCES users(id),
  ADD CONSTRAINT fk_inv_bdr         FOREIGN KEY (bdr_id) REFERENCES backdated_access_requests(id),
  ADD INDEX idx_inv_deleted (company_id, deleted_at);

ALTER TABLE payments
  ADD COLUMN deleted_at    DATETIME     NULL,
  ADD COLUMN deleted_by    INT UNSIGNED NULL,
  ADD COLUMN delete_reason VARCHAR(500) NULL,
  ADD COLUMN restored_at   DATETIME     NULL,
  ADD COLUMN restored_by   INT UNSIGNED NULL,
  ADD COLUMN is_backdated  TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN bdr_id        BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_p_deleted_by  FOREIGN KEY (deleted_by)  REFERENCES users(id),
  ADD CONSTRAINT fk_p_restored_by FOREIGN KEY (restored_by) REFERENCES users(id),
  ADD CONSTRAINT fk_p_bdr         FOREIGN KEY (bdr_id) REFERENCES backdated_access_requests(id),
  ADD INDEX idx_p_deleted (company_id, deleted_at);

--  Vouchers keep their existing REVERSED mechanism as the accounting truth —
--  a posted voucher is corrected by a mirroring one, not by disappearing. The
--  soft-delete columns exist only so a CEO deletion is recorded on the row it
--  concerns rather than inferred from the audit log.
ALTER TABLE vouchers
  ADD COLUMN deleted_at    DATETIME     NULL,
  ADD COLUMN deleted_by    INT UNSIGNED NULL,
  ADD COLUMN delete_reason VARCHAR(500) NULL,
  ADD COLUMN restored_at   DATETIME     NULL,
  ADD COLUMN restored_by   INT UNSIGNED NULL,
  ADD COLUMN is_backdated  TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN bdr_id        BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_v_deleted_by  FOREIGN KEY (deleted_by)  REFERENCES users(id),
  ADD CONSTRAINT fk_v_restored_by FOREIGN KEY (restored_by) REFERENCES users(id),
  ADD CONSTRAINT fk_v_bdr         FOREIGN KEY (bdr_id) REFERENCES backdated_access_requests(id),
  ADD INDEX idx_v_deleted (company_id, deleted_at);

-- ─── audit log: the fields §43 requires ─────────────────────────────────────
--  details JSON could have carried these, and that is exactly why they are
--  columns instead: a field nobody can query is a field nobody checks.
ALTER TABLE audit_logs
  ADD COLUMN actor_role         VARCHAR(40)     NULL AFTER user_id,
  ADD COLUMN request_type       ENUM('CHANGE','BDR','MIGRATION') NULL AFTER entity_id,
  ADD COLUMN request_id         BIGINT UNSIGNED NULL AFTER request_type,
  ADD COLUMN old_value          JSON            NULL AFTER details,
  ADD COLUMN proposed_value     JSON            NULL AFTER old_value,
  ADD COLUMN final_value        JSON            NULL AFTER proposed_value,
  ADD COLUMN reason             VARCHAR(1000)   NULL AFTER final_value,
  ADD COLUMN approver_id        INT UNSIGNED    NULL AFTER reason,
  ADD COLUMN admin_recommendation VARCHAR(30)   NULL AFTER approver_id,
  ADD COLUMN ceo_decision       VARCHAR(30)     NULL AFTER admin_recommendation,
  ADD COLUMN migration_batch_id BIGINT UNSIGNED NULL AFTER ceo_decision,
  ADD COLUMN session_id         VARCHAR(64)     NULL AFTER ip_address,
  ADD CONSTRAINT fk_audit_approver FOREIGN KEY (approver_id) REFERENCES users(id) ON DELETE SET NULL,
  ADD INDEX idx_audit_request (request_type, request_id),
  ADD INDEX idx_audit_batch   (migration_batch_id);
