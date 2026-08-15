-- ============================================================================
--  Company Settings module — additive migration for an EXISTING database.
--
--  schema.sql is a drop-and-recreate script and must never be re-run against
--  a live database with real data. This file only ADDs columns and is safe
--  to run once against an existing `companies` table.
--
--  This is not applied automatically — review it and run it yourself:
--    mysql -u <user> -p <database> < database/migrations/001_company_settings.sql
-- ============================================================================

ALTER TABLE companies
  ADD COLUMN website       VARCHAR(255) NULL AFTER email,
  ADD COLUMN logo_url      VARCHAR(255) NULL AFTER website,
  ADD COLUMN favicon_url   VARCHAR(255) NULL AFTER logo_url,
  ADD COLUMN tax_number    VARCHAR(60)  NULL AFTER vat_reg_no,
  ADD COLUMN trade_license VARCHAR(60)  NULL AFTER tax_number,
  ADD COLUMN is_configured TINYINT(1)   NOT NULL DEFAULT 0 AFTER currency;

-- Existing rows already have real company data filled in (name/address/etc.),
-- so mark them as configured to skip the setup wizard. Adjust the WHERE
-- clause if that assumption doesn't hold for your data.
UPDATE companies SET is_configured = 1 WHERE name IS NOT NULL AND name <> '';
