import { query, Row } from '../../config/db';
import { round2 } from '../../utils/money';

/**
 * Dashboard aggregates. Revenue/expense come straight from the books (voucher
 * entries against INCOME / EXPENSE ledgers) so the cards always reconcile with
 * the P&L — there is exactly one source of truth.
 */
export const dashboardService = {
  async summary(companyId: number) {
    const year = new Date().getFullYear();
    const from = `${year}-01-01`;
    const today = new Date().toISOString().slice(0, 10);
    const monthFrom = today.slice(0, 8) + '01';

    const pnl = await query<Row[]>(
      `SELECT g.nature,
              SUM(CASE WHEN ve.entry_type = 'CR' THEN ve.amount ELSE -ve.amount END) AS cr_net
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
         JOIN ledgers  l ON l.id = ve.ledger_id
         JOIN ledger_groups g ON g.id = l.group_id
        WHERE v.company_id = ? AND v.voucher_date BETWEEN ? AND ?
          AND g.nature IN ('INCOME','EXPENSE')
        GROUP BY g.nature`, [companyId, from, today]);
    let revenue = 0, expenses = 0;
    for (const r of pnl) {
      if (r.nature === 'INCOME') revenue = round2(Number(r.cr_net));
      else expenses = round2(-Number(r.cr_net));
    }

    const recv = await query<Row[]>(
      `SELECT COALESCE(SUM(total - paid_amount), 0) AS due
         FROM invoices WHERE company_id = ? AND status IN ('UNPAID','PARTIAL')`, [companyId]);

    const bookings = await query<Row[]>(
      `SELECT status, COUNT(*) AS n FROM bookings
        WHERE company_id = ? AND created_at >= ? GROUP BY status`, [companyId, monthFrom]);
    const bookingCounts: Record<string, number> = { PENDING: 0, CONFIRMED: 0, CANCELLED: 0 };
    for (const b of bookings) bookingCounts[b.status as string] = Number(b.n);

    const cash = await query<Row[]>(
      `SELECT COALESCE(SUM(CASE WHEN l.opening_type='DR' THEN l.opening_balance ELSE -l.opening_balance END),0)
              + COALESCE(SUM(t.dr_net),0) AS balance
         FROM ledgers l
         JOIN ledger_groups g ON g.id = l.group_id
         LEFT JOIN (
            SELECT ve.ledger_id,
                   SUM(CASE WHEN ve.entry_type='DR' THEN ve.amount ELSE -ve.amount END) AS dr_net
              FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
             WHERE v.company_id = ? GROUP BY ve.ledger_id
         ) t ON t.ledger_id = l.id
        WHERE l.company_id = ? AND g.name IN ('Cash-in-Hand','Bank Accounts')`,
      [companyId, companyId]);

    return {
      asOf: today,
      revenueYtd: revenue,
      expensesYtd: expenses,
      netProfitYtd: round2(revenue - expenses),
      receivables: round2(Number(recv[0].due)),
      cashAndBank: round2(Number(cash[0].balance)),
      bookingsThisMonth: Object.entries(bookingCounts).map(([status, count]) => ({ status, count }))
    };
  },

  /** Month-by-month revenue vs expense for the chart (current year). */
  async monthlySeries(companyId: number) {
    const year = new Date().getFullYear();
    const rows = await query<Row[]>(
      `SELECT MONTH(v.voucher_date) AS m, g.nature,
              SUM(CASE WHEN ve.entry_type = 'CR' THEN ve.amount ELSE -ve.amount END) AS cr_net
         FROM voucher_entries ve
         JOIN vouchers v ON v.id = ve.voucher_id
         JOIN ledgers  l ON l.id = ve.ledger_id
         JOIN ledger_groups g ON g.id = l.group_id
        WHERE v.company_id = ? AND YEAR(v.voucher_date) = ?
          AND g.nature IN ('INCOME','EXPENSE')
        GROUP BY MONTH(v.voucher_date), g.nature`, [companyId, year]);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const series = months.map((name, i) => ({ month: name, revenue: 0, expense: 0, profit: 0 }));
    for (const r of rows) {
      const s = series[Number(r.m) - 1];
      if (r.nature === 'INCOME') s.revenue = round2(Number(r.cr_net));
      else s.expense = round2(-Number(r.cr_net));
    }
    for (const s of series) s.profit = round2(s.revenue - s.expense);
    return series;
  },

  /** Revenue split by booking type (current year) for the donut chart. */
  async revenueByType(companyId: number) {
    const year = new Date().getFullYear();
    const rows = await query<Row[]>(
      `SELECT b.booking_type, SUM(i.total) AS amount
         FROM invoices i JOIN bookings b ON b.id = i.booking_id
        WHERE i.company_id = ? AND YEAR(i.invoice_date) = ? AND i.status <> 'VOID'
        GROUP BY b.booking_type`, [companyId, year]);
    return rows.map(r => ({ bookingType: r.booking_type, total: round2(Number(r.amount)) }));
  },

  /** Latest activity feed from the audit trail — scoped strictly to this company. */
  async recentActivity(companyId: number) {
    return query<Row[]>(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.created_at, u.name AS user_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
        WHERE u.company_id = ?
        ORDER BY a.id DESC LIMIT 15`, [companyId]);
  }
};
