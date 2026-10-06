-- ============================================================================
--  PARTY MASTER — de-duplication key and search index
--  Apply once after 007_correction_approvals.sql.
--
--  The historical books carry the same party under many spellings —
--  "SUN PHARMA", "Sun Pharma", "SUN  PHARMA" are one customer typed three
--  ways. Nothing in the schema stopped a third one being created, because
--  customers/suppliers had no unique key on the name at all.
--
--  name_key is that key: the name with case and whitespace taken out of the
--  comparison. It is GENERATED, so it can never drift from the name it is
--  derived from, and STORED so it can be indexed. The application still shows
--  and stores `name` exactly as the user typed it — only the *comparison* is
--  normalised.
--
--  Deliberately NOT normalised away: punctuation and spelling. "GROUPO
--  SORCHING" and "GROUPO SORCING" differ by one letter and are the same party;
--  "ECO SORCHING" and "GROUPO SORCHING" look just as close and are two
--  different parties. Only a human can tell those apart, so the alias
--  decisions live in docs/reports/CLIENT_DECISIONS.md, not in a DB rule.
-- ============================================================================

-- ─── customers ──────────────────────────────────────────────────────────────

ALTER TABLE customers
  ADD COLUMN name_key VARCHAR(150)
    AS (UPPER(TRIM(REGEXP_REPLACE(name, '[[:space:]]+', ' ')))) STORED
    AFTER name;

-- Existing rows may already hold duplicates under the old rules. Surface them
-- rather than letting the ALTER fail with an opaque error:
--   SELECT name_key, COUNT(*) c, GROUP_CONCAT(id) FROM customers
--    GROUP BY company_id, name_key HAVING c > 1;
ALTER TABLE customers
  ADD UNIQUE KEY uq_customer_name (company_id, name_key);

-- Prefix search for the picker: WHERE company_id = ? AND name LIKE 'sun%'.
-- The leading-edge index serves the common case; an infix match ("%pharma%")
-- still scans, which is acceptable at this table's size and is why the search
-- endpoint ranks prefix hits first.
ALTER TABLE customers
  ADD INDEX idx_c_company_name (company_id, name);

ALTER TABLE customers
  ADD INDEX idx_c_company_phone (company_id, phone);

-- ─── suppliers ──────────────────────────────────────────────────────────────

ALTER TABLE suppliers
  ADD COLUMN name_key VARCHAR(150)
    AS (UPPER(TRIM(REGEXP_REPLACE(name, '[[:space:]]+', ' ')))) STORED
    AFTER name;

ALTER TABLE suppliers
  ADD UNIQUE KEY uq_supplier_name (company_id, name_key);

ALTER TABLE suppliers
  ADD INDEX idx_s_company_name (company_id, name);

ALTER TABLE suppliers
  ADD INDEX idx_s_company_phone (company_id, phone);
