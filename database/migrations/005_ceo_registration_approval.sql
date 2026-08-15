-- Self-registration for non-CEO roles. CEO remains the only approver.
ALTER TABLE users
  ADD COLUMN approval_status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'APPROVED'
  AFTER is_active;

CREATE INDEX idx_users_approval ON users (company_id, approval_status, created_at);
