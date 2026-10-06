-- ============================================================================
--  019 · PREVIOUS DATA (SALES FILE ARCHIVE)
--  Apply once after 018_d007_period_acceptance_history.sql.
--
--  Re-runnable: every statement is guarded, so a second run is a no-op.
--
--  NOTE ON NUMBERING — the feature brief asked for `003_sales_files.sql`.
--  003 has been `003_tally_parity.sql` since the Tally-parity work, and the
--  chain is applied in order, so this takes the next free number instead.
-- ============================================================================
--
--  WHAT THIS IS, AND WHAT IT IS NOT
--
--  This is the *archive* of the monthly Excel sales workbooks: the file, what
--  each of its sheets turned out to be, and the ticket rows read out of them.
--  It exists so the office can find, filter and re-download the original sheet
--  a figure came from, and so the tickets in those sheets become bookings and
--  customers in the operational system.
--
--  It is NOT a second set of books. Nothing here posts a voucher. The audited
--  history — ledgers, vouchers, reconciliation, CEO acceptance — is the
--  migration engine's (009..018), and stays the only accounting authority for
--  the months it covers. `sales_files.closing_balance` is what the SHEET said,
--  not what the books say.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sales_files (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED    NOT NULL,

  file_name      VARCHAR(255)    NOT NULL,
  stored_path    VARCHAR(500)    NOT NULL,
  -- One workbook holds up to twenty sheets and only some of them are sales.
  -- The row is per SHEET, so `Sales FEB 2026` and `Sales MAR 2026` inside the
  -- same file are two rows, and re-importing is keyed on the pair.
  sheet_name     VARCHAR(255)    NOT NULL,
  -- SHA-256 of the workbook. A re-scan that sees the same bytes skips the
  -- file entirely; a changed workbook is re-read and the summary refreshed.
  content_hash   CHAR(64)        NOT NULL,

  --  SALES_REGISTER      the month's own sales sheet (SL NO / NAME / DATE /
  --                      TICKET NUMBER / … / OFFICE PAYMENT / CLAINT NAME)
  --  PARTY_LEDGER        one party's running statement (Debit / Credit / Due
  --                      Balance, or OFFICE PAYMENT DR / PAYMENT CR / BALANCE)
  --  SUPPLIER_STATEMENT  the GDS/consolidator statement of accounts. Read so
  --                      it can be told apart and NOT imported — it is money
  --                      payable to Hajee Air, not money owed to the company.
  --  UNRECOGNISED        everything else in the workbook: ACCOUNTS, bank
  --                      statements, expense sheets, outstanding summaries.
  sheet_shape    ENUM('SALES_REGISTER','PARTY_LEDGER','SUPPLIER_STATEMENT','UNRECOGNISED')
                 NOT NULL,
  skip_reason    VARCHAR(255)    NULL,

  month_label    VARCHAR(30)     NOT NULL,        -- e.g. "JUL-2026"
  month_year     DATE            NOT NULL,        -- first day of that month
  -- A party ledger runs from the day the relationship opened to the day the
  -- workbook was saved — WASHIM BHAI in the Jul-2026 file starts in Jun-2024.
  -- Such a sheet is cumulative and must never be added into a monthly total.
  is_cumulative  TINYINT(1)      NOT NULL DEFAULT 0,
  -- The same month's register is copied into the next month's workbook. Only
  -- the copy sitting in its OWN month's file is authoritative; the rest are
  -- kept, listed and downloadable, but excluded from every total.
  is_primary     TINYINT(1)      NOT NULL DEFAULT 0,
  period_from    DATE            NULL,
  period_to      DATE            NULL,

  customer_name  VARCHAR(255)    NULL,            -- party ledgers only
  total_tickets  INT UNSIGNED    NOT NULL DEFAULT 0,
  total_debit    DECIMAL(14,2)   NOT NULL DEFAULT 0.00,
  total_credit   DECIMAL(14,2)   NOT NULL DEFAULT 0.00,
  closing_balance DECIMAL(14,2)  NOT NULL DEFAULT 0.00,

  uploaded_by    INT UNSIGNED    NOT NULL,
  uploaded_at    TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_sf_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_sf_user    FOREIGN KEY (uploaded_by) REFERENCES users(id),

  UNIQUE KEY uq_sf_sheet          (company_id, file_name, sheet_name),
  INDEX      idx_sf_company_month (company_id, month_year),
  INDEX      idx_sf_customer      (company_id, customer_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
--  The ticket and payment rows themselves.
--
--  Kept for two reasons. First, `(sales_file_id, source_row)` is unique, which
--  is what makes "Scan & Import All" safe to press twice: a row already read
--  is never read again, so no customer and no booking is ever duplicated.
--  Second, a figure on the dashboard can be traced to the row and the line
--  number in the workbook a person can open.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_file_rows (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  sales_file_id  BIGINT UNSIGNED NOT NULL,
  source_row     INT UNSIGNED    NOT NULL,        -- Excel's own row number
  row_type       ENUM('TICKET','PAYMENT','OPENING','OTHER') NOT NULL,

  txn_date       DATE            NULL,
  ticket_no      VARCHAR(60)     NULL,
  pax_name       VARCHAR(255)    NULL,
  route          VARCHAR(255)    NULL,
  -- Who the row bills to: the CLAINT NAME column on a register, the sheet's
  -- party on a ledger. NOT the passenger — a passenger is who flew, and
  -- turning every passenger into a customer would bury the party master.
  party_name     VARCHAR(255)    NULL,

  debit          DECIMAL(14,2)   NOT NULL DEFAULT 0.00,
  credit         DECIMAL(14,2)   NOT NULL DEFAULT 0.00,
  running_balance DECIMAL(14,2)  NULL,

  customer_id    INT UNSIGNED    NULL,
  booking_id     BIGINT UNSIGNED NULL,

  created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_sfr_file     FOREIGN KEY (sales_file_id) REFERENCES sales_files(id) ON DELETE CASCADE,
  CONSTRAINT fk_sfr_customer FOREIGN KEY (customer_id)   REFERENCES customers(id),
  CONSTRAINT fk_sfr_booking  FOREIGN KEY (booking_id)    REFERENCES bookings(id),

  UNIQUE KEY uq_sfr_source (sales_file_id, source_row),
  INDEX      idx_sfr_type  (sales_file_id, row_type),
  INDEX      idx_sfr_party (party_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
