-- Phase 4 Q106-Q112. Staging-first and idempotent; never auto-approves a period.
INSERT INTO ledger_groups (company_id, parent_id, name, nature)
SELECT c.id, p.id, 'Loans & Advances', 'ASSET' FROM companies c
JOIN ledger_groups p ON p.company_id=c.id AND p.name='Current Assets'
WHERE NOT EXISTS (SELECT 1 FROM ledger_groups x WHERE x.company_id=c.id AND x.name='Loans & Advances');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id,g.id,'Loan to CEO - Rajib Sir',0,'DR',1 FROM companies c
JOIN ledger_groups g ON g.company_id=c.id AND g.name='Loans & Advances'
WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id=c.id AND x.name='Loan to CEO - Rajib Sir');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id,g.id,'Unidentified Historical Receipt / Customer Clearing',0,'CR',1 FROM companies c
JOIN ledger_groups g ON g.company_id=c.id AND g.name='Advance from Customers'
WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id=c.id AND x.name='Unidentified Historical Receipt / Customer Clearing');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id,g.id,'Unidentified / Ambiguous Historical Party',0,'DR',1 FROM companies c
JOIN ledger_groups g ON g.company_id=c.id AND g.name='Sundry Debtors'
WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id=c.id AND x.name='Unidentified / Ambiguous Historical Party');

SET @sql := IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='migration_batches' AND column_name='approval_outcome')=0,
'ALTER TABLE migration_batches ADD COLUMN approval_outcome ENUM("PENDING","VERIFIED_MIGRATED","ACCEPTED_HISTORICAL_DATA_LIMITATION") NOT NULL DEFAULT "PENDING" AFTER ceo_approval_status, ADD COLUMN approval_comment VARCHAR(1000) NULL AFTER approval_reason',
'SELECT "migration batch acceptance already extended"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF((SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='migration_review_items' AND column_name='resolution_code')=0,
'ALTER TABLE migration_review_items ADD COLUMN resolution_code VARCHAR(60) NULL AFTER resolution',
'SELECT "review resolution code already present"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS historical_party_reclassifications (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, company_id INT UNSIGNED NOT NULL,
 source_row_id BIGINT UNSIGNED NOT NULL, voucher_id BIGINT UNSIGNED NULL,
 from_ledger_id INT UNSIGNED NOT NULL, to_ledger_id INT UNSIGNED NOT NULL,
 amount DECIMAL(14,2) NOT NULL, evidence VARCHAR(1000) NOT NULL, reason VARCHAR(1000) NOT NULL,
 actor_id INT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT fk_hpr_company FOREIGN KEY(company_id) REFERENCES companies(id),
 CONSTRAINT fk_hpr_row FOREIGN KEY(source_row_id) REFERENCES migration_source_rows(id) ON DELETE CASCADE,
 CONSTRAINT fk_hpr_voucher FOREIGN KEY(voucher_id) REFERENCES vouchers(id) ON DELETE SET NULL,
 CONSTRAINT fk_hpr_from FOREIGN KEY(from_ledger_id) REFERENCES ledgers(id),
 CONSTRAINT fk_hpr_to FOREIGN KEY(to_ledger_id) REFERENCES ledgers(id),
 CONSTRAINT fk_hpr_actor FOREIGN KEY(actor_id) REFERENCES users(id), INDEX idx_hpr_row(source_row_id)
) ENGINE=InnoDB;
