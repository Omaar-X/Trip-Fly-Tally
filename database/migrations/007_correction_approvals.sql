-- ============================================================================
--  CORRECTION APPROVALS
--  Apply once after 006_password_reset_otp.sql.
--
--  Accountant and Sales may work freely going forward, but anything that
--  REWRITES history — a back-dated voucher, a reversal, a booking cancellation
--  that voids an invoice — now waits for Admin or CEO.
--
--  The request is parked here rather than posted-then-cancelled: vouchers are
--  immutable and are never deleted (see vouchers table), so a rejected entry
--  that had already been posted would leave a reversal pair in the ledger for
--  something that was never meant to happen. Nothing reaches the books until
--  it is approved.
-- ============================================================================

-- How old a date may be before it counts as a back entry. 0 = anything not
-- dated today needs approval.
ALTER TABLE companies
  ADD COLUMN back_entry_grace_days TINYINT UNSIGNED NOT NULL DEFAULT 7
  AFTER books_locked_upto;

CREATE TABLE IF NOT EXISTS approval_requests (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED    NOT NULL,

  -- What the requester was trying to do. On approval the original call is
  -- replayed through the same service path an Admin would have used, so the
  -- posting rules (balance, fiscal period, stock valuation) still apply.
  action         ENUM('VOUCHER_CREATE','VOUCHER_REVERSE',
                      'BOOKING_CREATE','BOOKING_CONFIRM','BOOKING_CANCEL',
                      'INVOICE_CREATE','PAYMENT_RECORD','PAYMENT_REVERSE',
                      'STOCK_MOVEMENT','STOCK_MOVEMENT_REVERSE')
                                 NOT NULL,
  target_id      BIGINT UNSIGNED NULL,   -- booking/voucher/payment acted upon
  payload        JSON            NOT NULL, -- original request body, replayed verbatim
  effective_date DATE            NULL,   -- the back-date that triggered the rule
  reason         VARCHAR(500)    NOT NULL, -- why the requester needs it

  -- WITHDRAWN: the requester called it off before anyone decided, so the
  -- approver's queue is not cluttered with requests nobody wants any more.
  status         ENUM('PENDING','APPROVED','REJECTED','WITHDRAWN','FAILED')
                                 NOT NULL DEFAULT 'PENDING',
  requested_by   INT UNSIGNED    NOT NULL,
  decided_by     INT UNSIGNED    NULL,
  decided_at     DATETIME        NULL,
  decision_note  VARCHAR(500)    NULL,

  -- FAILED means the approver said yes but the replay was refused (the period
  -- was locked meanwhile, a ledger was removed). The reason is kept so the
  -- request is not silently lost.
  result_id      BIGINT UNSIGNED NULL,   -- what got created on approval
  failure_reason VARCHAR(500)    NULL,

  -- A rejected request is never edited and re-decided: the requester fixes it
  -- and sends a NEW row pointing back here. Same discipline as vouchers — the
  -- rejection, its reason and who gave it all stay readable afterwards.
  resubmitted_from BIGINT UNSIGNED NULL,

  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_ar_company   FOREIGN KEY (company_id)   REFERENCES companies(id),
  CONSTRAINT fk_ar_requester FOREIGN KEY (requested_by) REFERENCES users(id),
  CONSTRAINT fk_ar_decider   FOREIGN KEY (decided_by)   REFERENCES users(id),
  CONSTRAINT fk_ar_prior     FOREIGN KEY (resubmitted_from) REFERENCES approval_requests(id),

  -- The approval queue: pending first, oldest first.
  INDEX idx_ar_queue  (company_id, status, created_at),
  INDEX idx_ar_mine   (company_id, requested_by, status),
  -- "Is this booking already awaiting cancellation?" — stops duplicate requests.
  INDEX idx_ar_target (company_id, action, target_id, status)
) ENGINE=InnoDB;
