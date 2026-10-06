-- ============================================================================
--  020 · IMPORTED HISTORICAL BOOKINGS ARE CONFIRMED
--  Apply once after 019_sales_files.sql.
--
--  Re-runnable: the UPDATE is idempotent and matches only rows the sales-file
--  importer created.
-- ============================================================================
--
--  A booking raised today is PENDING until somebody confirms it, because
--  confirming is what raises the invoice and posts the vouchers. A ticket read
--  out of a 2024 sales sheet was issued, flown and settled years ago, so
--  PENDING described it as awaiting an issue that had already happened.
--
--  The importer now records these CONFIRMED at insert. This brings rows
--  imported before that change into line.
--
--  ── CONFIRMED HERE IS A STATUS, NOT A POSTING ──────────────────────────────
--
--  No invoice is raised and no voucher is written by this statement, and none
--  may be. The ledgers for these months belong to the migration engine
--  (009..018); posting them a second time out of a sales sheet would double
--  the books, and every imported booking carries cost_price = 0, so a posting
--  would also book the whole sale as profit. `invoice_id` therefore stays
--  NULL, which is exactly what tells the rest of the system these were never
--  posted: `bookingsService.cancel()` checks it before attempting a reversal,
--  and `confirm()` refuses anything not PENDING, so these cannot be posted by
--  accident later.
--
--  The receivable for these months is reported from the sales sheets
--  themselves — see `modules/salesFiles/receivables.service.ts` — and the
--  audited receivable remains the accounting reports'.
-- ============================================================================

UPDATE bookings
   SET status = 'CONFIRMED'
 WHERE status = 'PENDING'
   AND invoice_id IS NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(details, '$.source')) = 'PREVIOUS_DATA';
