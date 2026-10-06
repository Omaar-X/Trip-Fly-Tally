-- ============================================================================
--  D005 · UNIDENTIFIED RECEIPT METHOD
--  Apply once after 015_phase5_material_review_workbench.sql.
--
--  Re-runnable: the INSERT is guarded, so a second run is a no-op.
--  ASCII only in the ledger name.
-- ============================================================================

-- Three evidenced HAQUE GROUP receipts (BDT 982,314.00, April-May 2024) name
-- their payer, date and amount, and leave the cell that would say CASH,
-- DBBL BANK or City bank empty. The receipt is genuine; only the account it
-- landed in is unknown.
--
-- Group: 'Current Assets' DIRECTLY, and deliberately not 'Cash-in-Hand' or
-- 'Bank Accounts'. Filing it under either of those would assert the very thing
-- the source does not say. It is a current asset whose exact account is
-- unidentified, and it says so.
--
-- is_system = 1: machinery, not an account anyone should rename or delete.
-- The balance is cleared later by an audited reclassification --
-- Dr real cash/bank, Cr this ledger -- which never touches the original
-- customer receipt.

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'Unidentified Receipt Method', 0.00, 'DR', 1
  FROM companies c
  JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Current Assets'
 WHERE NOT EXISTS (
   SELECT 1 FROM ledgers x
    WHERE x.company_id = c.id AND x.name = 'Unidentified Receipt Method');
