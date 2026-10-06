import { pool, query, Row } from '../config/db';
import { parsePeriod, defaultDataDir, NormalizedRow } from '../modules/migration/parser';

/**
 * D008 · what the source actually says about each cleared-but-unposted row.
 *
 * Read-only. Matches every open UNPOSTED_CLEARED_HISTORICAL_TRANSACTION back to
 * its parsed source line and prints the fields the accounting treatment depends
 * on — so the treatment is chosen from evidence rather than from the sign of a
 * number or the word REFUND in a cell.
 */
async function main(): Promise<void> {
  const items = await query<Row[]>(
    `SELECT r.id, r.source_period, r.source_sheet, r.source_row, r.source_amount
       FROM migration_review_items i JOIN migration_source_rows r ON r.id = i.source_row_id
      WHERE i.company_id = 1 AND i.issue_type = 'UNPOSTED_CLEARED_HISTORICAL_TRANSACTION'
        AND i.status = 'OPEN'
      ORDER BY r.source_period, r.source_sheet, r.source_row`);

  const periods = [...new Set(items.map((i) => String(i.source_period)))];
  const parsed = new Map<string, NormalizedRow[]>();
  for (const p of periods) parsed.set(p, (await parsePeriod(p, { dataDir: defaultDataDir() })).rows);

  const out: Record<string, unknown>[] = [];
  for (const item of items) {
    const rows = parsed.get(String(item.source_period)) ?? [];
    const match = rows.find((r) =>
      r.source.sheet === item.source_sheet && r.source.row === Number(item.source_row));
    out.push({
      id: item.id, period: item.source_period,
      sheet: item.source_sheet, row: item.source_row,
      found: !!match,
      kind: match?.kind ?? null,
      outcome: match?.outcome ?? null,
      date: match?.date ?? null,
      customer: match?.customer ?? null,
      vendor: match?.vendor ?? null,
      selling: match?.sellingAmount ?? null,
      cost: match?.costAmount ?? null,
      received: match?.receivedAmount ?? null,
      route: match?.route ?? null,
      remarks: match?.remarks ?? null,
      ticket: match?.ticketNo ?? null,
      method: match?.method ?? null,
      bank: match?.bankLedger ?? null,
      expenseLedger: match?.expenseLedger ?? null,
      serviceCategory: match?.serviceCategory ?? null,
    });
  }
  console.log(JSON.stringify(out, null, 1));
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
