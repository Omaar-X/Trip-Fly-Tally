-- ============================================================================
--  CEO DRAWINGS · AIRLINE PENALTY & LOSS
--  Apply once after 010_change_approval_and_bdr.sql.
--
--  Three ledgers the historical import cannot post without, from the client's
--  Phase 3 decisions.
--
--  Every statement below is written to be re-runnable: each INSERT is guarded
--  by a NOT EXISTS on the natural key, so applying this file twice changes
--  nothing the second time. That matters because these are being applied to a
--  staging copy first and then, later, to production.
--
--  ASCII ONLY, deliberately. These ledger names are resolved BY NAME in the
--  application, and `mysql.exe` on Windows defaults its client charset to the
--  console codepage — piping this file in without --default-character-set
--  turns an em-dash into "ÔÇö" and the lookup silently stops matching. Caught
--  on the staging run; the names now cannot be mangled by any client.
-- ============================================================================

-- ─── 1 · Owner / CEO Drawings, under Equity ─────────────────────────────────
--
--  A drawing is not an expense. Money the owner takes out reduces capital;
--  booking it under Expenses would understate profit by BDT 250k–330k in a
--  typical month, which is exactly what the historical sheets show under
--  "WITHDRAWN FROM RAZIB SIR".
--
--  The group sits under Capital Account so the Balance Sheet nets it against
--  capital on the equity side rather than showing it as a cost of trading.
--
--  IMPORTANT — this ledger is NOT a default destination. RAJIB SIR PERSONAL
--  and RAJIB SIR HAJJ transactions are NOT automatically posted here: the
--  historical source treatment comes first, and Drawings is used only where
--  the source clearly shows an owner withdrawal. Anything unclear becomes a
--  REVIEW_REQUIRED item. See backend/src/modules/migration/historicalRules.ts.

INSERT INTO ledger_groups (company_id, parent_id, name, nature, sort_order)
SELECT c.id, g.id, 'Owner / CEO Drawings', 'EQUITY', 2
  FROM companies c
  JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Capital Account'
 WHERE NOT EXISTS (
   SELECT 1 FROM ledger_groups x
    WHERE x.company_id = c.id AND x.name = 'Owner / CEO Drawings');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'CEO Drawings', 0.00, 'DR', 1
  FROM companies c
  JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Owner / CEO Drawings'
 WHERE NOT EXISTS (
   SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'CEO Drawings');

-- ─── 2 · Airline Penalty & Loss, with ADM and VOID kept apart ───────────────
--
--  ADM (Agency Debit Memo — an airline charging the agency back) and VOID (a
--  cancellation charge) are the same accounting nature: a loss the company
--  bears. They are still two ledgers rather than one.
--
--  Why separate: the client asked for it, and the reason holds up — "how much
--  did ADMs cost us last year" and "how much did voids cost us" are different
--  questions, and a single merged ledger can answer neither without going back
--  to the source rows. 23 ADM rows and 17 VOID rows in the historical set.

INSERT INTO ledger_groups (company_id, parent_id, name, nature, sort_order)
SELECT c.id, g.id, 'Airline Penalty & Loss', 'EXPENSE', 3
  FROM companies c
  JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Expenses'
 WHERE NOT EXISTS (
   SELECT 1 FROM ledger_groups x
    WHERE x.company_id = c.id AND x.name = 'Airline Penalty & Loss');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'ADM - Airline Debit Memo', 0.00, 'DR', 1
  FROM companies c
  JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Airline Penalty & Loss'
 WHERE NOT EXISTS (
   SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'ADM - Airline Debit Memo');

INSERT INTO ledgers (company_id, group_id, name, opening_balance, opening_type, is_system)
SELECT c.id, g.id, 'VOID - Ticket Void Charge', 0.00, 'DR', 1
  FROM companies c
  JOIN ledger_groups g ON g.company_id = c.id AND g.name = 'Airline Penalty & Loss'
 WHERE NOT EXISTS (
   SELECT 1 FROM ledgers x WHERE x.company_id = c.id AND x.name = 'VOID - Ticket Void Charge');
