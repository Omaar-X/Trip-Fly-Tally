-- ============================================================================
--  TRIP FLY BD ERP  ·  MySQL 8.4  ·  Schema (DDL)
--  Run order:  1) select/create the target database   2) schema.sql   3) seed.sql
--
--  Design principles
--  ─────────────────
--  • Every business row is scoped by company_id  →  multi-tenant ready
--  • Double-entry invariant enforced in the service layer (SUM DR = SUM CR)
--  • Append-only stock journal  →  FIFO / weighted-average via replay
--  • Soft-delete via is_active flags; hard deletes only on cascade children
--  • updated_at ON UPDATE CURRENT_TIMESTAMP on every mutable table
--  • All monetary values: DECIMAL(14,2)  (handles up to ~99 billion BDT)
--  • JSON columns for extensible/type-specific data (booking details)
-- ============================================================================

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS
  payslips, payroll_runs, employees,
  payments, invoice_items, invoices,
  bookings, stock_entries, items, warehouses,
  suppliers, customers,
  voucher_entries, vouchers, voucher_sequences, ledgers, ledger_groups,
  audit_logs, refresh_tokens, users, roles, companies;
SET FOREIGN_KEY_CHECKS = 1;


-- ============================================================================
--  FOUNDATION  ·  companies · roles · users · refresh_tokens · audit_logs
-- ============================================================================

-- companies ─── tenant root ─────────────────────────────────────────────────
--  Populated via the Company Settings module (backend/src/modules/companySettings),
--  not seed data. is_configured drives the first-login setup wizard.
CREATE TABLE companies (
  id             INT UNSIGNED       AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(150)       NOT NULL,
  address        VARCHAR(255),
  phone          VARCHAR(30),
  email          VARCHAR(120),
  website        VARCHAR(255),
  logo_url       VARCHAR(255),
  favicon_url    VARCHAR(255),
  vat_reg_no     VARCHAR(60),                     -- BIN / Bangladesh VAT reg
  tax_number     VARCHAR(60),                     -- TIN
  trade_license  VARCHAR(60),
  currency       VARCHAR(10)        NOT NULL DEFAULT 'BDT',
  -- Financial year and period control (Bangladesh FY runs July–June, so 7).
  --  books_begin_from   earliest date a voucher may carry; opening balances
  --                     are the position on the day before it.
  --  books_locked_upto  everything on or before this date is frozen — the
  --                     posting engine refuses to write into it.
  fy_start_month    TINYINT UNSIGNED NOT NULL DEFAULT 7,
  books_begin_from  DATE             NULL,
  books_locked_upto DATE             NULL,
  is_configured  TINYINT(1)         NOT NULL DEFAULT 0,
  created_at     TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- roles ─── RBAC catalogue ──────────────────────────────────────────────────
CREATE TABLE roles (
  id          INT UNSIGNED       AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(40)        NOT NULL UNIQUE,  -- machine name: ADMIN, etc.
  label       VARCHAR(80)        NOT NULL,
  description VARCHAR(255)
) ENGINE=InnoDB;

-- users ─── login accounts ──────────────────────────────────────────────────
CREATE TABLE users (
  id            INT UNSIGNED     AUTO_INCREMENT PRIMARY KEY,
  company_id    INT UNSIGNED     NOT NULL,
  role_id       INT UNSIGNED     NOT NULL,
  name          VARCHAR(120)     NOT NULL,
  email         VARCHAR(150)     NOT NULL UNIQUE,
  password_hash VARCHAR(100)     NOT NULL,          -- bcrypt
  is_active     TINYINT(1)       NOT NULL DEFAULT 1,
  approval_status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'APPROVED',
  created_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_users_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_users_role    FOREIGN KEY (role_id)    REFERENCES roles(id),

  INDEX idx_users_company       (company_id),
  INDEX idx_users_email_active  (email, is_active)     -- login lookup
) ENGINE=InnoDB;

-- refresh_tokens ─── server-side token rotation ────────────────────────────
CREATE TABLE refresh_tokens (
  id         BIGINT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED       NOT NULL,
  token_hash CHAR(64)           NOT NULL,           -- SHA-256 of opaque token
  expires_at DATETIME           NOT NULL,
  revoked_at DATETIME           NULL,
  created_at TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,

  INDEX idx_rt_user (user_id),
  INDEX idx_rt_hash (token_hash)
) ENGINE=InnoDB;

-- password_reset_otps ─── one-time email OTPs for password recovery ────────
CREATE TABLE password_reset_otps (
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

-- audit_logs ─── append-only activity trail ────────────────────────────────
--  Written by audit middleware; never updated or deleted.
CREATE TABLE audit_logs (
  id         BIGINT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED       NULL,
  action     VARCHAR(60)        NOT NULL,           -- e.g. VOUCHER_CREATE
  entity     VARCHAR(60)        NOT NULL,
  entity_id  BIGINT UNSIGNED    NULL,
  details    JSON               NULL,
  ip_address VARCHAR(45),
  created_at TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,

  INDEX idx_audit_entity        (entity, entity_id),
  INDEX idx_audit_user_time     (user_id, created_at),
  INDEX idx_audit_time          (created_at)
) ENGINE=InnoDB;


-- ============================================================================
--  ACCOUNTING CORE  ·  ledger_groups · ledgers · vouchers · voucher_entries
-- ============================================================================

-- ledger_groups ─── Tally-style account tree ───────────────────────────────
--  nature drives every financial report:
--    ASSET / EXPENSE     →  debit-normal
--    LIABILITY / EQUITY / INCOME  →  credit-normal
--  parent_id (self FK) allows deep group trees:
--    Assets → Current Assets → Bank Accounts → City Bank
CREATE TABLE ledger_groups (
  id         INT UNSIGNED       AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED       NOT NULL,
  parent_id  INT UNSIGNED       NULL,
  name       VARCHAR(100)       NOT NULL,
  nature     ENUM('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE') NOT NULL,
  sort_order SMALLINT UNSIGNED  NOT NULL DEFAULT 0,  -- display ordering

  CONSTRAINT fk_lg_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_lg_parent  FOREIGN KEY (parent_id)  REFERENCES ledger_groups(id),

  UNIQUE KEY uq_lg               (company_id, name),
  INDEX      idx_lg_nature       (company_id, nature),
  INDEX      idx_lg_parent       (parent_id)
) ENGINE=InnoDB;

-- ledgers ─── individual accounts ──────────────────────────────────────────
--  Opening balance stored with DR/CR side exactly like Tally.
--  is_system = 1 means the application owns this ledger (protected from delete).
CREATE TABLE ledgers (
  id              INT UNSIGNED   AUTO_INCREMENT PRIMARY KEY,
  company_id      INT UNSIGNED   NOT NULL,
  group_id        INT UNSIGNED   NOT NULL,
  name            VARCHAR(120)   NOT NULL,
  opening_balance DECIMAL(14,2)  NOT NULL DEFAULT 0.00,
  opening_type    ENUM('DR','CR') NOT NULL DEFAULT 'DR',
  is_system       TINYINT(1)     NOT NULL DEFAULT 0,
  created_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_l_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_l_group   FOREIGN KEY (group_id)   REFERENCES ledger_groups(id),

  UNIQUE KEY uq_ledger           (company_id, name),
  INDEX      idx_l_group         (group_id),
  INDEX      idx_l_company_sys   (company_id, is_system)
) ENGINE=InnoDB;

-- vouchers ─── transaction header ──────────────────────────────────────────
--  A voucher is only written when its entries balance (service-layer check
--  inside a DB transaction).  voucher_no is sequential per company.
--
--  Vouchers are immutable and are NEVER deleted or edited. A correction is a
--  new voucher whose entries mirror the original (DR <-> CR), linked in both
--  directions:
--      status                  ACTIVE   | REVERSED (superseded)
--      reversal_of_voucher_id  set on the correcting voucher
--      reversed_by_voucher_id  set on the voucher that was corrected
--  A reversal voucher is itself ACTIVE — it is a real posting that stands on
--  its own; reversal_of_voucher_id IS NOT NULL is what marks it as a reversal.
CREATE TABLE vouchers (
  id           BIGINT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  company_id   INT UNSIGNED     NOT NULL,
  voucher_no   VARCHAR(30)      NOT NULL,
  voucher_type ENUM(
    'JOURNAL','PAYMENT','RECEIPT','SALES','PURCHASE',
    'CONTRA','DEBIT_NOTE','CREDIT_NOTE'
  ) NOT NULL,
  voucher_date DATE             NOT NULL,
  narration    VARCHAR(500),
  reference    VARCHAR(120),               -- invoice no / booking no / cheque
  total_amount DECIMAL(14,2)   NOT NULL,   -- = SUM(DR side) = SUM(CR side)
  status       ENUM('ACTIVE','REVERSED') NOT NULL DEFAULT 'ACTIVE',
  reversal_of_voucher_id BIGINT UNSIGNED NULL,   -- this voucher reverses that one
  reversed_by_voucher_id BIGINT UNSIGNED NULL,   -- that voucher reverses this one
  reversed_by  INT UNSIGNED     NULL,            -- who authorised the reversal
  reversed_at  DATETIME         NULL,
  reversal_reason VARCHAR(500)  NULL,
  created_by   INT UNSIGNED     NOT NULL,
  created_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_v_company     FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_v_user        FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_v_reversal_of FOREIGN KEY (reversal_of_voucher_id) REFERENCES vouchers(id),
  CONSTRAINT fk_v_reversed_by FOREIGN KEY (reversed_by_voucher_id) REFERENCES vouchers(id),
  CONSTRAINT fk_v_reversed_usr FOREIGN KEY (reversed_by)           REFERENCES users(id),

  UNIQUE KEY uq_voucher_no          (company_id, voucher_no),
  INDEX      idx_v_date             (company_id, voucher_date),
  INDEX      idx_v_type_date        (company_id, voucher_type, voucher_date),
  INDEX      idx_v_reference        (company_id, reference),
  INDEX      idx_v_reversal_of      (reversal_of_voucher_id),
  INDEX      idx_v_status           (company_id, status)
) ENGINE=InnoDB;

-- voucher_sequences ─── per-financial-year document numbering ─────────────
--  One row per (company, document kind, financial year). Numbers are drawn by
--  an atomic UPDATE … last_no = last_no + 1, so concurrent posting can never
--  hand out the same number twice, and every sequence restarts on the first
--  day of a new financial year exactly as Tally does.
--
--  doc_kind is either a voucher type (JOURNAL, SALES, RECEIPT …) or a
--  document family (INVOICE, BOOKING, PAYMENT).
CREATE TABLE voucher_sequences (
  id         INT UNSIGNED   AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED   NOT NULL,
  doc_kind   VARCHAR(30)    NOT NULL,
  fy_label   CHAR(9)        NOT NULL,          -- '2026-2027'
  last_no    INT UNSIGNED   NOT NULL DEFAULT 0,
  updated_at TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_vseq_company FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_vseq (company_id, doc_kind, fy_label)
) ENGINE=InnoDB;

-- voucher_entries ─── double-entry lines (≥ 2 per voucher) ─────────────────
--  Service layer asserts SUM(DR amount) = SUM(CR amount) per voucher.
CREATE TABLE voucher_entries (
  id         BIGINT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  voucher_id BIGINT UNSIGNED    NOT NULL,
  ledger_id  INT UNSIGNED       NOT NULL,
  entry_type ENUM('DR','CR')    NOT NULL,
  amount     DECIMAL(14,2)      NOT NULL CHECK (amount > 0),
  line_note  VARCHAR(255),

  CONSTRAINT fk_ve_voucher FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
  CONSTRAINT fk_ve_ledger  FOREIGN KEY (ledger_id)  REFERENCES ledgers(id),

  INDEX idx_ve_ledger  (ledger_id),
  INDEX idx_ve_voucher (voucher_id),
  -- Covering index for ledger statement queries
  INDEX idx_ve_ledger_cover (ledger_id, voucher_id, entry_type, amount)
) ENGINE=InnoDB;


-- ============================================================================
--  CRM  ·  customers · suppliers
-- ============================================================================

-- customers ─── each has a 1:1 receivable sub-ledger ───────────────────────
CREATE TABLE customers (
  id           INT UNSIGNED     AUTO_INCREMENT PRIMARY KEY,
  company_id   INT UNSIGNED     NOT NULL,
  ledger_id    INT UNSIGNED     NOT NULL UNIQUE, -- receivable sub-ledger
  name         VARCHAR(150)     NOT NULL,
  email        VARCHAR(150),
  phone        VARCHAR(30),
  address      VARCHAR(255),
  passport_no  VARCHAR(40),                      -- travel-agency specific
  credit_limit DECIMAL(14,2)   NOT NULL DEFAULT 0.00,
  is_active    TINYINT(1)       NOT NULL DEFAULT 1,
  created_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_c_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_c_ledger  FOREIGN KEY (ledger_id)  REFERENCES ledgers(id),

  INDEX      idx_c_company_active (company_id, is_active),
  FULLTEXT   ft_c_name_email      (name, email)
) ENGINE=InnoDB;

-- suppliers ─── payable-side mirror (airlines, hotels, GDS vendors) ─────────
CREATE TABLE suppliers (
  id         INT UNSIGNED       AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED       NOT NULL,
  ledger_id  INT UNSIGNED       NOT NULL UNIQUE, -- payable sub-ledger
  name       VARCHAR(150)       NOT NULL,
  email      VARCHAR(150),
  phone      VARCHAR(30),
  address    VARCHAR(255),
  is_active  TINYINT(1)         NOT NULL DEFAULT 1,
  created_at TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP          NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_s_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_s_ledger  FOREIGN KEY (ledger_id)  REFERENCES ledgers(id),

  INDEX    idx_s_company_active (company_id, is_active),
  FULLTEXT ft_s_name_email      (name, email)
) ENGINE=InnoDB;


-- ============================================================================
--  INVENTORY  ·  warehouses · items · stock_entries
-- ============================================================================

CREATE TABLE warehouses (
  id         INT UNSIGNED       AUTO_INCREMENT PRIMARY KEY,
  company_id INT UNSIGNED       NOT NULL,
  name       VARCHAR(100)       NOT NULL,
  location   VARCHAR(150),
  is_active  TINYINT(1)         NOT NULL DEFAULT 1,

  CONSTRAINT fk_w_company FOREIGN KEY (company_id) REFERENCES companies(id),
  UNIQUE KEY uq_wh (company_id, name)
) ENGINE=InnoDB;

-- items ─── SKU catalogue ───────────────────────────────────────────────────
CREATE TABLE items (
  id             INT UNSIGNED   AUTO_INCREMENT PRIMARY KEY,
  company_id     INT UNSIGNED   NOT NULL,
  sku            VARCHAR(50)    NOT NULL,
  name           VARCHAR(150)   NOT NULL,
  description    VARCHAR(500),
  category       VARCHAR(80),
  unit           VARCHAR(20)    NOT NULL DEFAULT 'pcs',
  purchase_price DECIMAL(14,2)  NOT NULL DEFAULT 0.00,
  sale_price     DECIMAL(14,2)  NOT NULL DEFAULT 0.00,
  reorder_level  DECIMAL(12,3)  NOT NULL DEFAULT 0.000,
  is_active      TINYINT(1)     NOT NULL DEFAULT 1,
  created_at     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_i_company FOREIGN KEY (company_id) REFERENCES companies(id),

  UNIQUE KEY uq_sku              (company_id, sku),
  INDEX      idx_i_category      (company_id, category),
  INDEX      idx_i_active        (company_id, is_active),
  FULLTEXT   ft_i_name           (name, sku)
) ENGINE=InnoDB;

-- stock_entries ─── immutable IN/OUT movement journal ──────────────────────
--  FIFO and weighted-average valuation computed by replaying this table
--  ordered by (entry_date, id)  →  the single source of stock truth.
CREATE TABLE stock_entries (
  id           BIGINT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  company_id   INT UNSIGNED     NOT NULL,
  item_id      INT UNSIGNED     NOT NULL,
  warehouse_id INT UNSIGNED     NOT NULL,
  supplier_id  INT UNSIGNED     NULL,      -- set when an IN is bought on credit
  entry_type   ENUM('IN','OUT') NOT NULL,
  quantity     DECIMAL(12,3)    NOT NULL CHECK (quantity > 0),
  rate         DECIMAL(14,2)    NOT NULL DEFAULT 0.00,
  value_amount DECIMAL(14,2)    NOT NULL DEFAULT 0.00,  -- what the voucher booked
  voucher_id   BIGINT UNSIGNED  NULL,
  entry_date   DATE             NOT NULL,
  note         VARCHAR(255),
  created_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_se_item     FOREIGN KEY (item_id)      REFERENCES items(id),
  CONSTRAINT fk_se_wh       FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  CONSTRAINT fk_se_supplier FOREIGN KEY (supplier_id)  REFERENCES suppliers(id),
  CONSTRAINT fk_se_voucher  FOREIGN KEY (voucher_id)   REFERENCES vouchers(id) ON DELETE SET NULL,

  -- Covering index for FIFO replay and stock-on-hand queries
  INDEX idx_se_item_date   (item_id, entry_date, id),
  INDEX idx_se_wh_item     (warehouse_id, item_id, entry_type),
  INDEX idx_se_company_date (company_id, entry_date)
) ENGINE=InnoDB;


-- ============================================================================
--  TRAVEL  ·  bookings
-- ============================================================================

-- bookings ─── FLIGHT / HOTEL / TOUR ──────────────────────────────────────
--  `details` JSON holds type-specific fields: PNR, airline, route,
--  hotel name, nights, pax count, tour package name, etc.
--  On CONFIRM: service layer creates an invoice + SALES voucher atomically.
CREATE TABLE bookings (
  id           BIGINT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  company_id   INT UNSIGNED     NOT NULL,
  booking_no   VARCHAR(30)      NOT NULL,
  customer_id  INT UNSIGNED     NOT NULL,
  booking_type ENUM('FLIGHT','HOTEL','TOUR') NOT NULL,
  status       ENUM('PENDING','CONFIRMED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  travel_date  DATE,
  return_date  DATE,
  details      JSON,
  cost_price   DECIMAL(14,2)    NOT NULL DEFAULT 0.00,
  sale_price   DECIMAL(14,2)    NOT NULL DEFAULT 0.00,
  supplier_id  INT UNSIGNED     NULL,
  agent_id     INT UNSIGNED     NULL,               -- selling employee
  invoice_id   BIGINT UNSIGNED  NULL,               -- set on confirmation
  purchase_voucher_id BIGINT UNSIGNED NULL,         -- supplier-cost voucher, set on confirmation
  created_by   INT UNSIGNED     NOT NULL,
  created_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_b_company  FOREIGN KEY (company_id)  REFERENCES companies(id),
  CONSTRAINT fk_b_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_b_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_b_user     FOREIGN KEY (created_by)  REFERENCES users(id),
  CONSTRAINT fk_b_purchase_voucher FOREIGN KEY (purchase_voucher_id)
    REFERENCES vouchers(id) ON DELETE SET NULL,

  UNIQUE KEY uq_booking_no         (company_id, booking_no),
  INDEX      idx_b_status_date     (company_id, status, created_at),
  INDEX      idx_b_customer        (customer_id),
  INDEX      idx_b_travel_date     (company_id, travel_date),
  INDEX      idx_b_purchase_voucher (purchase_voucher_id)
) ENGINE=InnoDB;


-- ============================================================================
--  INVOICING  ·  invoices · invoice_items · payments
-- ============================================================================

CREATE TABLE invoices (
  id           BIGINT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  company_id   INT UNSIGNED     NOT NULL,
  invoice_no   VARCHAR(30)      NOT NULL,
  customer_id  INT UNSIGNED     NOT NULL,
  booking_id   BIGINT UNSIGNED  NULL,
  invoice_date DATE             NOT NULL,
  due_date     DATE,
  subtotal     DECIMAL(14,2)    NOT NULL,
  discount     DECIMAL(14,2)    NOT NULL DEFAULT 0.00,
  vat_percent  DECIMAL(5,2)     NOT NULL DEFAULT 0.00,
  vat_amount   DECIMAL(14,2)    NOT NULL DEFAULT 0.00,
  total        DECIMAL(14,2)    NOT NULL,            -- subtotal - discount + vat
  paid_amount  DECIMAL(14,2)    NOT NULL DEFAULT 0.00,
  status       ENUM('UNPAID','PARTIAL','PAID','VOID') NOT NULL DEFAULT 'UNPAID',
  voucher_id   BIGINT UNSIGNED  NULL,
  notes        VARCHAR(500),
  created_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_inv_company  FOREIGN KEY (company_id)  REFERENCES companies(id),
  CONSTRAINT fk_inv_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_inv_booking  FOREIGN KEY (booking_id)  REFERENCES bookings(id) ON DELETE SET NULL,
  CONSTRAINT fk_inv_voucher  FOREIGN KEY (voucher_id)  REFERENCES vouchers(id) ON DELETE SET NULL,

  UNIQUE KEY uq_invoice_no             (company_id, invoice_no),
  INDEX      idx_inv_status_date       (company_id, status, invoice_date),
  INDEX      idx_inv_customer_status   (customer_id, status),
  INDEX      idx_inv_due               (company_id, due_date, status)   -- aging reports
) ENGINE=InnoDB;

CREATE TABLE invoice_items (
  id          BIGINT UNSIGNED   AUTO_INCREMENT PRIMARY KEY,
  invoice_id  BIGINT UNSIGNED   NOT NULL,
  description VARCHAR(255)      NOT NULL,
  quantity    DECIMAL(12,3)     NOT NULL DEFAULT 1.000,
  rate        DECIMAL(14,2)     NOT NULL,
  amount      DECIMAL(14,2)     NOT NULL,            -- quantity × rate

  CONSTRAINT fk_ii_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  INDEX idx_ii_invoice (invoice_id)
) ENGINE=InnoDB;

-- payments ─── every movement of money in or out ───────────────────────────
--  Each row posts a RECEIPT or PAYMENT voucher; voucher_id is the proof link.
--
--  (direction, counterparty_type) is the canonical model and spans all four
--  real-world cases:
--      IN  + CUSTOMER   customer pays us         (receipt)
--      OUT + CUSTOMER   we pay a customer back   (refund)
--      OUT + SUPPLIER   we pay a supplier        (supplier payment)
--      IN  + SUPPLIER   supplier pays us back    (supplier credit)
--  customer_id / supplier_id are kept in sync by the service layer purely so
--  existing queries, reports and PDFs keep working — they are a compatibility
--  view over the pair above, not the source of truth.
CREATE TABLE payments (
  id           BIGINT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  company_id   INT UNSIGNED     NOT NULL,
  payment_no   VARCHAR(30)      NOT NULL,
  direction    ENUM('IN','OUT') NOT NULL,
  counterparty_type ENUM('CUSTOMER','SUPPLIER') NULL,
  counterparty_id   INT UNSIGNED NULL,
  customer_id  INT UNSIGNED     NULL,          -- legacy mirror of counterparty
  supplier_id  INT UNSIGNED     NULL,          -- legacy mirror of counterparty
  invoice_id   BIGINT UNSIGNED  NULL,
  refund_of_payment_id BIGINT UNSIGNED NULL,   -- set when this row refunds another
  method       ENUM('CASH','BANK','BKASH','NAGAD','CARD') NOT NULL DEFAULT 'CASH',
  amount       DECIMAL(14,2)    NOT NULL CHECK (amount > 0),
  payment_date DATE             NOT NULL,
  voucher_id   BIGINT UNSIGNED  NULL,
  notes        VARCHAR(255),
  reason       VARCHAR(255),                   -- why a refund was issued
  created_by   INT UNSIGNED     NOT NULL,
  created_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_p_company  FOREIGN KEY (company_id)  REFERENCES companies(id),
  CONSTRAINT fk_p_customer FOREIGN KEY (customer_id) REFERENCES customers(id),
  CONSTRAINT fk_p_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  CONSTRAINT fk_p_invoice  FOREIGN KEY (invoice_id)  REFERENCES invoices(id) ON DELETE SET NULL,
  CONSTRAINT fk_p_voucher  FOREIGN KEY (voucher_id)  REFERENCES vouchers(id) ON DELETE SET NULL,
  CONSTRAINT fk_p_user     FOREIGN KEY (created_by)  REFERENCES users(id),
  CONSTRAINT fk_p_refund_of FOREIGN KEY (refund_of_payment_id) REFERENCES payments(id),

  UNIQUE KEY uq_payment_no       (company_id, payment_no),
  INDEX      idx_p_date          (company_id, payment_date),
  INDEX      idx_p_direction_date (company_id, direction, payment_date),
  INDEX      idx_p_invoice       (invoice_id),
  INDEX      idx_p_counterparty  (company_id, counterparty_type, counterparty_id),
  INDEX      idx_p_refund_of     (refund_of_payment_id)
) ENGINE=InnoDB;


-- ============================================================================
--  HR & PAYROLL  ·  employees · attendance · payroll_runs · payslips
-- ============================================================================

CREATE TABLE employees (
  id              INT UNSIGNED   AUTO_INCREMENT PRIMARY KEY,
  company_id      INT UNSIGNED   NOT NULL,
  user_id         INT UNSIGNED   NULL,              -- optional login link
  emp_code        VARCHAR(30)    NOT NULL,
  name            VARCHAR(120)   NOT NULL,
  designation     VARCHAR(80),
  department      VARCHAR(80),
  phone           VARCHAR(30),
  email           VARCHAR(150),
  joining_date    DATE,
  basic_salary    DECIMAL(14,2)  NOT NULL DEFAULT 0.00,
  house_rent      DECIMAL(14,2)  NOT NULL DEFAULT 0.00,
  medical_allow   DECIMAL(14,2)  NOT NULL DEFAULT 0.00,
  conveyance      DECIMAL(14,2)  NOT NULL DEFAULT 0.00,
  commission_rate DECIMAL(5,2)   NOT NULL DEFAULT 0.00, -- % of booking profit
  is_active       TINYINT(1)     NOT NULL DEFAULT 1,
  created_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_e_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_e_user    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE SET NULL,

  UNIQUE KEY uq_emp_code   (company_id, emp_code),
  INDEX      idx_e_dept    (company_id, department),
  INDEX      idx_e_active  (company_id, is_active),
  FULLTEXT   ft_e_name     (name, email)
) ENGINE=InnoDB;

--  NOTE: there is no attendance table. Attendance is kept in a separate
--  system, so payroll does not derive an absence deduction — the deduction is
--  entered per employee as a taka figure when a run is generated. See
--  database/migrations/004_remove_attendance.sql.

-- payroll_runs ─── one run per company per month ───────────────────────────
--  APPROVED: posts Dr Salary Expense / Cr Salaries Payable voucher.
--  PAID:     posts Dr Salaries Payable / Cr Cash or Bank voucher.
CREATE TABLE payroll_runs (
  id           BIGINT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  company_id   INT UNSIGNED     NOT NULL,
  period_year  SMALLINT         NOT NULL,
  period_month TINYINT          NOT NULL,           -- 1..12
  status       ENUM('DRAFT','APPROVED','PAID') NOT NULL DEFAULT 'DRAFT',
  total_net    DECIMAL(14,2)    NOT NULL DEFAULT 0.00,
  voucher_id   BIGINT UNSIGNED  NULL,
  created_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_pr_company FOREIGN KEY (company_id) REFERENCES companies(id),
  CONSTRAINT fk_pr_voucher FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE SET NULL,

  UNIQUE KEY uq_run (company_id, period_year, period_month)
) ENGINE=InnoDB;

-- payslips ─── per-employee line within a payroll run ──────────────────────
--  net_pay = basic + allowances + commission − deduction
--  `deduction` is entered per employee, not derived: absence is worked out in
--  whatever system owns attendance, and only the resulting figure lands here.
CREATE TABLE payslips (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  payroll_run_id    BIGINT UNSIGNED NOT NULL,
  employee_id       INT UNSIGNED    NOT NULL,
  basic             DECIMAL(14,2)   NOT NULL,
  allowances        DECIMAL(14,2)   NOT NULL,        -- rent + medical + conveyance
  commission        DECIMAL(14,2)   NOT NULL DEFAULT 0.00,
  deduction         DECIMAL(14,2)   NOT NULL DEFAULT 0.00,
  net_pay           DECIMAL(14,2)   NOT NULL,

  CONSTRAINT fk_ps_run FOREIGN KEY (payroll_run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_ps_emp FOREIGN KEY (employee_id)    REFERENCES employees(id),

  UNIQUE KEY uq_payslip       (payroll_run_id, employee_id),
  INDEX      idx_ps_employee  (employee_id)
) ENGINE=InnoDB;


-- ============================================================================
--  DEFERRED FK  ·  bookings.agent_id (employees created after bookings)
-- ============================================================================

ALTER TABLE bookings
  ADD CONSTRAINT fk_b_agent FOREIGN KEY (agent_id)
    REFERENCES employees(id) ON DELETE SET NULL;
