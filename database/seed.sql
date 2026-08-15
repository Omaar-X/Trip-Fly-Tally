-- ============================================================================
--  TRIP FLY ERP  ·  Seed data  (run after schema.sql)
--
--  This is a PRODUCTION-READY EMPTY BASELINE, not demo data. It seeds only:
--    1. The 5 system roles
--    2. 1 bootstrap CEO account; other roles register for CEO approval
--    3. A blank placeholder company (is_configured = 0) so users.company_id
--       has something to point at — the CEO completes real setup via the
--       Company Setup Wizard on first login
--    4. The default Chart of Accounts (ledger groups + system ledgers the
--       accounting engine requires to post vouchers), all at zero balance
--
--  It deliberately seeds NO customers, vendors, employees, invoices, bookings,
--  payments, vouchers, accounting transactions, attendance, or payroll — see
--  DATA_CLEANUP_REPORT.md for what used to be here and why it was removed.
--
--  Bootstrap CEO account (deployment password is never documented here)
--  ──────────────────────────────────────────────────────────────────────────
--  CEO credentials are configured securely for the deployment environment.
-- ============================================================================

-- ─── Company ─────────────────────────────────────────────────────────────────
--  Blank placeholder only — scaffolding so the FK on users.company_id has
--  something to point at. Never put real production company data here; the
--  first CEO login is redirected to the Company Settings setup wizard
--  (is_configured = 0) to fill in the real name/address/branding/logo.
--  fy_start_month 7 = Bangladesh's July–June financial year, and the books
--  open on the first day of the FY in progress. The CEO can move both in the
--  setup wizard, but only until the first voucher is posted — after that every
--  opening balance and voucher number is interpreted against them.
INSERT INTO companies (id, name, logo_url, currency, fy_start_month, books_begin_from, is_configured) VALUES
  (1, 'Trip Fly BD', '/branding/trip-fly-bd-logo.png', 'BDT', 7,
   MAKEDATE(IF(MONTH(CURDATE()) >= 7, YEAR(CURDATE()), YEAR(CURDATE()) - 1), 1) + INTERVAL 6 MONTH,
   0);

-- ─── Roles ───────────────────────────────────────────────────────────────────
INSERT INTO roles (id, name, label, description) VALUES
  (1, 'CEO',        'Chief Executive Officer', 'Full system access — final approval authority, company settings, user management, audit, database tools, all reports'),
  (2, 'ADMIN',       'Administrator',          'Daily operations and review. Cannot give final approval, cannot access database/audit tools'),
  (3, 'ACCOUNTANT',  'Accountant',             'Full accounting operations — ledgers, vouchers, accounting reports. Cannot approve final postings, no HR or system settings access'),
  (4, 'SALES',       'Sales Executive',        'Customers, bookings, collections. No accounting access beyond customer-facing statements'),
  (5, 'HR',          'HR Manager',             'Employee management and attendance/leave only. No payroll approval, no accounting access, no financial reports');

-- ─── Bootstrap CEO user (deployment password is never stored in source) ───────
INSERT INTO users (id, company_id, role_id, name, email, password_hash, approval_status) VALUES
  (1, 1, 1, 'MD Samsuddin Razib', 'MDRAZIB69@gmail.com',    '$2a$10$k50S8xoJiaXRlVcvJJ03mOX36DyOvJnh8d/s9qmvoMuYZyaWqkbje', 'APPROVED');


-- ============================================================================
--  DEFAULT CHART OF ACCOUNTS
--  Structural scaffolding the accounting engine requires (SYSTEM_LEDGERS in
--  backend/src/utils/systemLedgers.ts resolves these by name when posting
--  vouchers for payments, bookings, and payroll). All opening balances are
--  zero — this is a template, not a funded company.
-- ============================================================================

INSERT INTO ledger_groups (id, company_id, parent_id, name, nature, sort_order) VALUES
  -- Assets
  (1,  1, NULL, 'Assets',                 'ASSET',     1),
  (2,  1, 1,    'Current Assets',         'ASSET',     1),
  (3,  1, 2,    'Cash-in-Hand',           'ASSET',     1),
  (4,  1, 2,    'Bank Accounts',          'ASSET',     2),
  (5,  1, 2,    'Sundry Debtors',         'ASSET',     3),
  (6,  1, 2,    'Stock-in-Hand',          'ASSET',     4),
  -- Liabilities
  (7,  1, NULL, 'Liabilities',            'LIABILITY', 2),
  (8,  1, 7,    'Sundry Creditors',       'LIABILITY', 1),
  (9,  1, 7,    'Duties & Taxes',         'LIABILITY', 2),
  (10, 1, 7,    'Salaries Payable',       'LIABILITY', 3),
  -- Equity
  (11, 1, NULL, 'Capital Account',        'EQUITY',    3),
  -- Income
  (12, 1, NULL, 'Income',                 'INCOME',    4),
  (13, 1, 12,   'Travel Sales',           'INCOME',    1),
  -- Expenses
  (14, 1, NULL, 'Expenses',               'EXPENSE',   5),
  (15, 1, 14,   'Direct Expenses',        'EXPENSE',   1),
  (16, 1, 14,   'Indirect Expenses',      'EXPENSE',   2);

-- System ledgers — required by name for the accounting engine to post
-- payments/bookings/payroll vouchers. Zero opening balance (empty template).
INSERT INTO ledgers (id, company_id, group_id, name, opening_balance, opening_type, is_system) VALUES
  (1,  1, 3,  'Cash in Hand',            0.00, 'DR', 1),
  (2,  1, 4,  'City Bank — A/C 110245',  0.00, 'DR', 1),
  (3,  1, 4,  'bKash Merchant Wallet',   0.00, 'DR', 1),
  (4,  1, 11, 'Owner''s Capital',        0.00, 'CR', 1),
  (5,  1, 13, 'Sales — Air Tickets',     0.00, 'DR', 1),
  (6,  1, 13, 'Sales — Hotel Bookings',  0.00, 'DR', 1),
  (7,  1, 13, 'Sales — Tour Packages',   0.00, 'DR', 1),
  (8,  1, 9,  'VAT Payable',             0.00, 'CR', 1),
  (9,  1, 15, 'Cost of Services',        0.00, 'DR', 1),
  (10, 1, 16, 'Salary Expense',          0.00, 'DR', 1),
  (11, 1, 10, 'Salaries Payable',        0.00, 'CR', 1),
  -- Each money channel keeps its own ledger. Collapsing Nagad into the bKash
  -- wallet or card settlements into the bank account leaves both sides
  -- unreconcilable against the real statement.
  (12, 1, 4,  'Nagad Merchant Wallet',   0.00, 'DR', 1),
  (13, 1, 4,  'Card Settlement Account', 0.00, 'DR', 1),
  -- Inventory control accounts — stock movements post through these, so the
  -- Balance Sheet carries real closing stock and the P&L a real cost of goods.
  (14, 1, 6,  'Stock in Hand',           0.00, 'DR', 1),
  (15, 1, 15, 'Cost of Goods Sold',      0.00, 'DR', 1),
  (16, 1, 15, 'Stock Adjustment',        0.00, 'DR', 1);

-- Default warehouse — every stock movement needs a warehouse_id, so shipping
-- zero warehouses would leave the inventory module unusable on a fresh install.
INSERT INTO warehouses (id, company_id, name, location, is_active) VALUES
  (1, 1, 'Main Warehouse', NULL, 1);
