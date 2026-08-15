-- Email OTP password recovery. Apply once after 005_ceo_registration_approval.sql.
CREATE TABLE IF NOT EXISTS password_reset_otps (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  otp_hash   CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  attempts   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  used_at    DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_reset_otp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_reset_otp_user (user_id, created_at),
  INDEX idx_reset_otp_expiry (expires_at)
) ENGINE=InnoDB;
