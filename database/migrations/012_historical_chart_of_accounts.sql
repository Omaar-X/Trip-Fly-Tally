-- ============================================================================
--  CHART OF ACCOUNTS FOR THE HISTORICAL DATA
--  Apply once after 011_drawings_and_penalty_ledgers.sql.
--
--  Every group and ledger below is taken from a line that actually appears on
--  the company's own month-end ACCOUNTS sheets or in its day books. Nothing is
--  invented: where the source has no evidence for a subcategory, there is no
--  subcategory here. The evidence is cited per block.
--
--  ASCII names only — see the note in migration 011. These are matched BY NAME
--  by the poster, and mysql.exe on Windows will mangle anything else.
--
--  Re-runnable: every INSERT is guarded by NOT EXISTS on the natural key.
-- ============================================================================

-- ─── helper pattern ─────────────────────────────────────────────────────────
--  Each block is:  create the group if absent, then its ledgers if absent.
--  Written out rather than proceduralised so a reader can see exactly what
--  lands in the books.

-- ─── 1 · Banks ──────────────────────────────────────────────────────────────
--  Evidence: every ACCOUNTS sheet's "AT BANK" block names SBAC, UCB and BRAC.
--  Dec-2024: SBAC 1,445 · UCB 237,671.08 · BRAC 2,412,262.38.
--  No account numbers are fabricated.
--
--  BRAC is created here rather than assumed. A newer seed.sql ships it, but a
--  database seeded before that does not have it, and the poster resolves this
--  ledger BY NAME — on a database without it, every bank receipt and payment
--  silently failed to post with "the source does not say whether it was cash
--  or bank". Assuming the seed had run cost a full migration pass to find.

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'BRAC Bank', 0.00, 'DR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Bank Accounts'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'BRAC Bank');

--  Cash in Hand is a system ledger the seed always creates, but the same
--  reasoning applies: the poster needs it by name.
INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Cash in Hand', 0.00, 'DR', 1
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Cash-in-Hand'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Cash in Hand');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'SBAC Bank', 0.00, 'DR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Bank Accounts'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'SBAC Bank');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'UCB Bank', 0.00, 'DR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Bank Accounts'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'UCB Bank');

--  Evidence: the Mar-May 2024 party ledger records receipts against "DBBL
--  BANK" in its account column. It is named by the source, so it gets a
--  ledger; no account number is fabricated.
INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'DBBL Bank', 0.00, 'DR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Bank Accounts'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'DBBL Bank');

-- ─── 2 · Fixed Assets ───────────────────────────────────────────────────────
--  Evidence: Dec-2024 "FIXED ASSET 850,000 — LAND & SHOP PURCHASE
--  (INSTALLMENT) 850,000"; the earlier Dec version also carries "AC 50,520".
--  Only these two. No furniture, no IT equipment — the source shows none.

INSERT INTO ledger_groups (company_id, parent_id, name, nature, sort_order)
SELECT c.id, g.id, 'Fixed Assets', 'ASSET', 5
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Assets'
 WHERE NOT EXISTS (SELECT 1 FROM ledger_groups x WHERE x.company_id = c.id AND x.name = 'Fixed Assets');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Land and Shop Purchase (Instalment)', 0.00, 'DR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Fixed Assets'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Land and Shop Purchase (Instalment)');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Air Conditioner', 0.00, 'DR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Fixed Assets'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Air Conditioner');

-- ─── 3 · Loans and borrowings ───────────────────────────────────────────────
--  Evidence: ACCOUNTS "LOAN RECEIVED"; day-book narrations "LOAN RECEIVED
--  MADAME", "ABHIJIT LOAN PAID", "LOAN PAID FROM ECO-FUAD"; bank-statement
--  remark "LOAN RECEIVED MADAME"; LOAN CALCULATION.xlsx "MADAME RECEIVED /
--  MADAME PAID".
--
--  Lender-specific sub-ledgers only for the three lenders the sources name.
--  Principal and interest are NOT split here: the sources do not separate
--  them, and inventing the split is exactly what the rules forbid.

INSERT INTO ledger_groups (company_id, parent_id, name, nature, sort_order)
SELECT c.id, g.id, 'Loans and Borrowings', 'LIABILITY', 4
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Liabilities'
 WHERE NOT EXISTS (SELECT 1 FROM ledger_groups x WHERE x.company_id = c.id AND x.name = 'Loans and Borrowings');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Loan - Madame (Tahmina Bashar)', 0.00, 'CR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Loans and Borrowings'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Loan - Madame (Tahmina Bashar)');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Loan - Abhijit Dey', 0.00, 'CR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Loans and Borrowings'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Loan - Abhijit Dey');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Loan - Eco Fuad', 0.00, 'CR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Loans and Borrowings'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Loan - Eco Fuad');

-- ─── 4 · Advances from customers ────────────────────────────────────────────
--  Evidence: ACCOUNTS "ADVANCE FROM SUN PHARMA / ALAM BHAI / HASAN SIR".
--  Money held before the service — a liability, not revenue.

INSERT INTO ledger_groups (company_id, parent_id, name, nature, sort_order)
SELECT c.id, g.id, 'Advance from Customers', 'LIABILITY', 5
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Liabilities'
 WHERE NOT EXISTS (SELECT 1 FROM ledger_groups x WHERE x.company_id = c.id AND x.name = 'Advance from Customers');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Advance - Sun Pharma', 0.00, 'CR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Advance from Customers'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Advance - Sun Pharma');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Advance - Alam Bhai', 0.00, 'CR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Advance from Customers'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Advance - Alam Bhai');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Advance - Hasan Sir', 0.00, 'CR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Advance from Customers'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Advance - Hasan Sir');

-- ─── 5 · Bank and financial charges ─────────────────────────────────────────
--  Evidence: "BANK CHARGE & COMMISION" on every ACCOUNTS sheet, and dozens of
--  sub-taka "BANK CHARGE" lines in the 2025 day books.

INSERT INTO ledger_groups (company_id, parent_id, name, nature, sort_order)
SELECT c.id, g.id, 'Bank and Financial Charges', 'EXPENSE', 4
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Expenses'
 WHERE NOT EXISTS (SELECT 1 FROM ledger_groups x WHERE x.company_id = c.id AND x.name = 'Bank and Financial Charges');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Bank Charge and Commission', 0.00, 'DR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Bank and Financial Charges'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Bank Charge and Commission');

-- ─── 6 · Operating expenses ─────────────────────────────────────────────────
--  One ledger per line that actually appears on the ACCOUNTS sheets. The
--  original source wording is preserved in the voucher narration; these are the
--  normalised names the reports group by.
--
--  Source lines, Dec-2024: BAZAR · CONVIENCE · OTHERS/MILAD · COMPUTAR
--  ACCSESORIES · PRINTING & STATIONARY · REPAIR & MAINTAINCE · RENT ·
--  SALARY (EMPLOYERS) · SALARY (OWNERS) · LICENSE RENEWAL · CAR REPAIR BILL ·
--  MOHIM BHAI FUEL · HUJUR SALARY · TAX PAY · AMANAT PURPOSE · BUSINESS CARD
--  (Madame & Sir) · PROMOSSIONAL EXPENSES.
--
--  Note on SALARY (OWNERS): the source presents it as an expense, so it is one
--  here. Owner *withdrawals* are a different line and go to CEO Drawings.

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, v.n, 0.00, 'DR', 0
  FROM companies c
  JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Indirect Expenses'
  JOIN (SELECT 'Office Bazar' AS n
        UNION ALL SELECT 'Conveyance'
        UNION ALL SELECT 'Others / Milad'
        UNION ALL SELECT 'Computer Accessories'
        UNION ALL SELECT 'Printing and Stationery'
        UNION ALL SELECT 'Repair and Maintenance'
        UNION ALL SELECT 'Office Rent'
        UNION ALL SELECT 'Salary - Owners'
        UNION ALL SELECT 'License Renewal'
        UNION ALL SELECT 'Car Repair Bill'
        UNION ALL SELECT 'Vehicle Fuel'
        UNION ALL SELECT 'Hujur Salary'
        UNION ALL SELECT 'Tax Paid'
        UNION ALL SELECT 'Amanat Purpose'
        UNION ALL SELECT 'Business Card'
        UNION ALL SELECT 'Promotional Expenses') v
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = v.n);

-- ─── 7 · Income the sources name beyond ticket sales ────────────────────────
--  Evidence: the sales registers carry a "Service" column separate from the
--  fare, and the requisition forms state a "SERVICE CHARGE".

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Service Charge Income', 0.00, 'CR', 0
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Travel Sales'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Service Charge Income');

-- ─── 8 · Suspense, for rows that must post but cannot yet be classified ─────
--  Deliberately created so the poster never has to choose between inventing a
--  ledger and dropping a row. Anything landing here is also a REVIEW_REQUIRED
--  item, and a month with a non-zero suspense balance is visibly unfinished.

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Historical Suspense', 0.00, 'DR', 1
  FROM companies c JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Current Assets'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'Historical Suspense');
