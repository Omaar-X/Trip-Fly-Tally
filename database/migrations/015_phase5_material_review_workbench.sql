-- Phase 5 material historical review workbench.
-- Idempotent, staging-first, and deliberately contains no period approvals.
CREATE TABLE IF NOT EXISTS historical_review_actions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  review_item_id BIGINT UNSIGNED NOT NULL,
  action_code VARCHAR(60) NOT NULL,
  prior_status VARCHAR(30) NOT NULL,
  resulting_status VARCHAR(30) NOT NULL,
  evidence VARCHAR(2000) NOT NULL,
  rule_code VARCHAR(100) NULL,
  actor_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hra_company FOREIGN KEY(company_id) REFERENCES companies(id),
  CONSTRAINT fk_hra_item FOREIGN KEY(review_item_id) REFERENCES migration_review_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_hra_actor FOREIGN KEY(actor_id) REFERENCES users(id),
  INDEX idx_hra_item(review_item_id), INDEX idx_hra_company_action(company_id, action_code)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS historical_review_reclassifications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED NOT NULL,
  review_item_id BIGINT UNSIGNED NOT NULL,
  source_row_id BIGINT UNSIGNED NOT NULL,
  original_voucher_id BIGINT UNSIGNED NOT NULL,
  reclassification_voucher_id BIGINT UNSIGNED NOT NULL,
  from_ledger_id INT UNSIGNED NOT NULL,
  to_ledger_id INT UNSIGNED NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  evidence VARCHAR(2000) NOT NULL,
  rule_code VARCHAR(100) NOT NULL,
  actor_id INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_hrr_company FOREIGN KEY(company_id) REFERENCES companies(id),
  CONSTRAINT fk_hrr_item FOREIGN KEY(review_item_id) REFERENCES migration_review_items(id),
  CONSTRAINT fk_hrr_source FOREIGN KEY(source_row_id) REFERENCES migration_source_rows(id),
  CONSTRAINT fk_hrr_original_voucher FOREIGN KEY(original_voucher_id) REFERENCES vouchers(id),
  CONSTRAINT fk_hrr_reclass_voucher FOREIGN KEY(reclassification_voucher_id) REFERENCES vouchers(id),
  CONSTRAINT fk_hrr_from FOREIGN KEY(from_ledger_id) REFERENCES ledgers(id),
  CONSTRAINT fk_hrr_to FOREIGN KEY(to_ledger_id) REFERENCES ledgers(id),
  CONSTRAINT fk_hrr_actor FOREIGN KEY(actor_id) REFERENCES users(id),
  UNIQUE KEY uq_hrr_review_item(review_item_id)
) ENGINE=InnoDB;
