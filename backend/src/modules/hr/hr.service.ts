import { PoolConnection } from 'mysql2/promise';
import { query, exec, withTransaction, Row, WriteResult } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { round2 } from '../../utils/money';
import { today, endOfMonth, startOfMonth } from '../../utils/date';
import { findLedgerId, moneyLedgerName, SYSTEM_LEDGERS } from '../../utils/systemLedgers';
import { postVoucherTx } from '../accounting/accounting.service';
import { loadBooksPolicyTx } from '../accounting/fiscalPeriod.service';
import { financialReversalService } from '../accounting/reversal.service';

export interface EmployeeInput {
  empCode: string; name: string; designation?: string; department?: string;
  phone?: string; email?: string; joiningDate?: string;
  basicSalary: number; houseRent?: number; medicalAllow?: number; conveyance?: number;
  commissionRate?: number;
}

export interface GenerateOptions {
  /**
   * Deduction in taka, per employee id. Absence, late marks and unpaid leave
   * are all worked out in whatever system owns attendance; only the resulting
   * figure is recorded here.
   */
  deductions?: Record<number, number>;
}

/**
 * ============================ SALARY ENGINE ==================================
 * For period (year, month) and each active employee:
 *
 *   gross      = basic + houseRent + medicalAllow + conveyance
 *   commission = commissionRate% × Σ(salePrice − costPrice) over CONFIRMED
 *                bookings whose invoice falls in the period
 *   deduction  = whatever the caller supplied for that employee (default 0)
 *   netPay     = gross + commission − deduction
 *
 * There is deliberately no attendance here. This ERP does not own attendance,
 * so it does not pretend to derive an absence deduction from it: guessing at
 * working days and present days it cannot see would produce a number that
 * looks authoritative and is not. The deduction arrives as a plain figure.
 *
 * Approving the run posts ONE balanced JOURNAL voucher:
 *   Dr Salary Expense       Σ netPay
 *   Cr Salaries Payable     Σ netPay
 * Marking PAID posts a PAYMENT voucher:
 *   Dr Salaries Payable     Σ netPay
 *   Cr Cash/Bank            Σ netPay
 * ============================================================================
 */
export const hrService = {
  // ------------------------------ employees ---------------------------------
  async listEmployees(companyId: number) {
    return query<Row[]>(
      `SELECT e.*, (e.basic_salary + e.house_rent + e.medical_allow + e.conveyance) AS gross_salary
         FROM employees e WHERE e.company_id = ? ORDER BY e.emp_code`, [companyId]);
  },

  async createEmployee(companyId: number, input: EmployeeInput) {
    const dup = await query<Row[]>(
      `SELECT id FROM employees WHERE company_id = ? AND emp_code = ?`, [companyId, input.empCode]);
    if (dup.length) throw ApiError.conflict(`Employee code ${input.empCode} already exists`);
    const res = await exec(
      `INSERT INTO employees (company_id, emp_code, name, designation, department, phone, email,
                              joining_date, basic_salary, house_rent, medical_allow, conveyance, commission_rate)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [companyId, input.empCode, input.name, input.designation ?? null, input.department ?? null,
       input.phone ?? null, input.email ?? null, input.joiningDate ?? null,
       round2(input.basicSalary), round2(input.houseRent ?? 0), round2(input.medicalAllow ?? 0),
       round2(input.conveyance ?? 0), round2(input.commissionRate ?? 0)]);
    return res.insertId;
  },

  async updateEmployee(companyId: number, id: number, input: Partial<EmployeeInput> & { isActive?: boolean }) {
    const fields: string[] = []; const params: unknown[] = [];
    const map: [keyof typeof input, string][] = [
      ['name', 'name'], ['designation', 'designation'], ['department', 'department'],
      ['phone', 'phone'], ['email', 'email'], ['joiningDate', 'joining_date'],
      ['basicSalary', 'basic_salary'], ['houseRent', 'house_rent'], ['medicalAllow', 'medical_allow'],
      ['conveyance', 'conveyance'], ['commissionRate', 'commission_rate'], ['isActive', 'is_active']
    ];
    for (const [k, col] of map) {
      if (input[k] !== undefined) { fields.push(`${col} = ?`); params.push(input[k]); }
    }
    if (!fields.length) throw ApiError.badRequest('Nothing to update');
    params.push(companyId, id);
    const res = await exec(
      `UPDATE employees SET ${fields.join(', ')} WHERE company_id = ? AND id = ?`, params);
    if (!res.affectedRows) throw ApiError.notFound('Employee not found');
  },

  // ------------------------------ payroll -----------------------------------
  async listRuns(companyId: number) {
    return query<Row[]>(
      `SELECT pr.*, v.voucher_no,
              (SELECT COUNT(*) FROM payslips ps WHERE ps.payroll_run_id = pr.id) AS employees
         FROM payroll_runs pr LEFT JOIN vouchers v ON v.id = pr.voucher_id
        WHERE pr.company_id = ? ORDER BY pr.period_year DESC, pr.period_month DESC`, [companyId]);
  },

  async runDetail(companyId: number, runId: number) {
    const runs = await query<Row[]>(
      `SELECT pr.*, v.voucher_no FROM payroll_runs pr
         LEFT JOIN vouchers v ON v.id = pr.voucher_id
        WHERE pr.company_id = ? AND pr.id = ?`, [companyId, runId]);
    if (!runs.length) throw ApiError.notFound('Payroll run not found');
    const slips = await query<Row[]>(
      `SELECT ps.*, e.emp_code, e.name, e.designation,
              (ps.basic + ps.allowances) AS gross
         FROM payslips ps JOIN employees e ON e.id = ps.employee_id
        WHERE ps.payroll_run_id = ? ORDER BY e.emp_code`, [runId]);
    return { ...runs[0], payslips: slips };
  },

  /** Generate (or regenerate while DRAFT) the salary run for a month. */
  async generateRun(companyId: number, year: number, month: number, options: GenerateOptions = {}) {
    const deductions = options.deductions ?? {};
    return withTransaction(async (conn) => {
      const [existing] = await conn.query<Row[]>(
        `SELECT * FROM payroll_runs WHERE company_id = ? AND period_year = ? AND period_month = ? FOR UPDATE`,
        [companyId, year, month]);
      let runId: number;
      if (existing.length) {
        if (existing[0].status !== 'DRAFT')
          throw ApiError.conflict(`Payroll for ${year}-${month} is already ${existing[0].status}`);
        runId = existing[0].id;
        await conn.query(`DELETE FROM payslips WHERE payroll_run_id = ?`, [runId]);
      } else {
        const [res] = await conn.query<WriteResult>(
          `INSERT INTO payroll_runs (company_id, period_year, period_month) VALUES (?,?,?)`,
          [companyId, year, month]);
        runId = res.insertId;
      }

      const { from, to } = monthRange(year, month);

      const [employees] = await conn.query<Row[]>(
        `SELECT * FROM employees WHERE company_id = ? AND is_active = 1`, [companyId]);
      if (!employees.length) throw ApiError.badRequest('No active employees');

      // A deduction against somebody who is not on this run is a typo, not a
      // deduction — and silently ignoring it would quietly overpay them.
      const active = new Set(employees.map(e => Number(e.id)));
      const strays = Object.keys(deductions).map(Number).filter(id => !active.has(id));
      if (strays.length)
        throw ApiError.badRequest(
          `Deductions were supplied for employee ${strays.join(', ')}, who ${strays.length > 1 ? 'are' : 'is'} ` +
          `not an active employee in this run`);

      // Agent commission: a share of the margin on bookings whose REVENUE was
      // recognised in this period — the invoice date, not the date someone
      // keyed the booking in. Commission and the margin it is paid on now land
      // in the same month, and a booking that has since been cancelled (its
      // invoice VOID) no longer earns one.
      const [comm] = await conn.query<Row[]>(
        `SELECT b.agent_id, SUM(b.sale_price - b.cost_price) AS margin
           FROM bookings b
           JOIN invoices i ON i.id = b.invoice_id
          WHERE b.company_id = ? AND b.status = 'CONFIRMED' AND b.agent_id IS NOT NULL
            AND i.status <> 'VOID' AND i.invoice_date BETWEEN ? AND ?
          GROUP BY b.agent_id`, [companyId, from, to]);
      const margins = new Map<number, number>(comm.map(r => [r.agent_id as number, Number(r.margin)]));

      let totalNet = 0;
      let totalDeduction = 0;
      const values: unknown[][] = [];
      for (const e of employees) {
        const gross = round2(Number(e.basic_salary) + Number(e.house_rent)
                           + Number(e.medical_allow) + Number(e.conveyance));
        const allowances = round2(gross - Number(e.basic_salary));
        const commission = round2((margins.get(e.id) ?? 0) * Number(e.commission_rate) / 100);
        const deduction = round2(deductions[Number(e.id)] ?? 0);

        if (deduction < 0)
          throw ApiError.badRequest(`Deduction for ${e.name} cannot be negative`);
        // A deduction larger than everything earned would mean the employee
        // owes the company for turning up — almost certainly a slipped decimal.
        if (deduction > round2(gross + commission))
          throw ApiError.badRequest(
            `Deduction ${deduction.toFixed(2)} for ${e.name} exceeds their ` +
            `${round2(gross + commission).toFixed(2)} gross plus commission`);

        const netPay = round2(gross + commission - deduction);
        totalNet = round2(totalNet + netPay);
        totalDeduction = round2(totalDeduction + deduction);
        values.push([runId, e.id, Number(e.basic_salary), allowances, commission, deduction, netPay]);
      }
      await conn.query(
        `INSERT INTO payslips (payroll_run_id, employee_id, basic,
                               allowances, commission, deduction, net_pay)
         VALUES ?`, [values]);
      await conn.query(`UPDATE payroll_runs SET total_net = ? WHERE id = ?`, [totalNet, runId]);
      return {
        runId, year, month,
        employees: employees.length,
        totalDeduction,
        totalNet,
      };
    });
  },

  /**
   * DRAFT → APPROVED. Books the salary liability.
   *
   * The accrual is dated the LAST DAY OF THE PERIOD, so June's salary is June's
   * expense however late the approval comes — approving used to stamp the
   * server's current date and quietly move payroll cost into whatever month the
   * approval happened in.
   *
   * …but never later than today. Payroll is routinely approved a few days
   * before month end, and dating that accrual on the 31st would be a
   * future-dated voucher the posting engine rightly refuses — which made the
   * current month impossible to approve at all until it was over.
   */
  async approveRun(companyId: number, userId: number, runId: number,
                   options: { date?: string } = {}) {
    return withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);
      const run = await lockRun(conn, companyId, runId);
      if (run.status !== 'DRAFT') throw ApiError.conflict(`Run is already ${run.status}`);
      const total = round2(Number(run.total_net));
      if (!(total > 0)) throw ApiError.badRequest('Run total is zero — generate payslips first');

      const date = options.date ?? accrualDate(run);
      const expenseId = await findLedgerId(conn, companyId, SYSTEM_LEDGERS.SALARY_EXPENSE);
      const payableId = await findLedgerId(conn, companyId, SYSTEM_LEDGERS.SALARIES_PAYABLE);
      const voucher = await postVoucherTx(conn, companyId, userId, {
        type: 'JOURNAL', date,
        narration: `Salary for ${periodLabel(run)}`,
        entries: [
          { ledgerId: expenseId, type: 'DR', amount: total, note: 'Monthly salary expense' },
          { ledgerId: payableId, type: 'CR', amount: total, note: 'Salaries payable' }
        ]
      }, { policy });
      await conn.query(`UPDATE payroll_runs SET status = 'APPROVED', voucher_id = ? WHERE id = ?`,
        [voucher.voucherId, runId]);
      return { runId, status: 'APPROVED', voucherNo: voucher.voucherNo, date, total };
    });
  },

  /**
   * APPROVED → DRAFT. Reverses the accrual so a run approved in error can be
   * corrected and re-generated.
   *
   * There was no way back before this: an approved run's journal sat on the
   * books permanently, with the run frozen out of regeneration. A PAID run is
   * not eligible — the money has left, so that has to be unwound as a payment
   * first.
   */
  async unapproveRun(companyId: number, userId: number, runId: number,
                     options: { reason?: string; date?: string } = {}) {
    return withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);
      const run = await lockRun(conn, companyId, runId);
      if (run.status === 'PAID')
        throw ApiError.conflict(
          `Payroll for ${periodLabel(run)} has already been paid — the disbursement must be reversed first`);
      if (run.status !== 'APPROVED')
        throw ApiError.conflict(`Only APPROVED runs can be un-approved (current: ${run.status})`);

      const reversal = run.voucher_id
        ? await financialReversalService.reverseIfActiveTx(
            conn, companyId, userId, Number(run.voucher_id),
            { reason: options.reason ?? `Un-approval of payroll ${periodLabel(run)}`,
              date: options.date, policy })
        : null;

      await conn.query(
        `UPDATE payroll_runs SET status = 'DRAFT', voucher_id = NULL WHERE id = ?`, [runId]);

      return {
        runId, status: 'DRAFT',
        reversalVoucherNo: reversal?.reversalVoucherNo ?? null,
        reversalDate: reversal?.reversalDate ?? null,
      };
    });
  },

  /** APPROVED → PAID. Releases the cash. */
  async payRun(companyId: number, userId: number, runId: number,
               method: 'CASH' | 'BANK' | 'BKASH' | 'NAGAD' | 'CARD' = 'BANK',
               options: { date?: string } = {}) {
    return withTransaction(async (conn) => {
      const policy = await loadBooksPolicyTx(conn, companyId);
      const run = await lockRun(conn, companyId, runId);
      if (run.status !== 'APPROVED') throw ApiError.conflict('Only APPROVED runs can be paid');
      const total = round2(Number(run.total_net));

      // Disbursement is dated when the money actually moved — today unless the
      // caller says otherwise, and never before the expense it settles. The
      // comparison is against the accrual voucher's ACTUAL date, not the end of
      // the period: a run approved mid-month accrues on the approval day, and
      // paying it the same day is perfectly ordinary.
      const date = options.date ?? today();
      const [accrual] = await conn.query<Row[]>(
        'SELECT voucher_date FROM vouchers WHERE id = ?', [run.voucher_id]);
      const accrued = (accrual[0]?.voucher_date as string) ?? periodEnd(run);
      if (date < accrued)
        throw ApiError.badRequest(
          `Salary cannot be paid on ${date}, before the ${periodLabel(run)} accrual dated ${accrued}`);

      const payableId = await findLedgerId(conn, companyId, SYSTEM_LEDGERS.SALARIES_PAYABLE);
      const moneyId = await findLedgerId(conn, companyId, moneyLedgerName(method));
      const voucher = await postVoucherTx(conn, companyId, userId, {
        type: 'PAYMENT', date,
        narration: `Salary disbursement ${periodLabel(run)} via ${method}`,
        entries: [
          { ledgerId: payableId, type: 'DR', amount: total, note: 'Clear salaries payable' },
          { ledgerId: moneyId, type: 'CR', amount: total, note: method }
        ]
      }, { policy });
      await conn.query(`UPDATE payroll_runs SET status = 'PAID' WHERE id = ?`, [runId]);
      return { runId, status: 'PAID', voucherNo: voucher.voucherNo, date, total };
    });
  },

  async payslip(companyId: number, slipId: number) {
    const rows = await query<Row[]>(
      `SELECT ps.*, e.emp_code, e.name, e.designation, e.department,
              pr.period_year, pr.period_month, pr.status AS run_status, pr.company_id
         FROM payslips ps
         JOIN employees e ON e.id = ps.employee_id
         JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
        WHERE pr.company_id = ? AND ps.id = ?`, [companyId, slipId]);
    if (!rows.length) throw ApiError.notFound('Payslip not found');
    return rows[0];
  }
};

// ------------------------------- helpers ------------------------------------

async function lockRun(conn: PoolConnection, companyId: number, runId: number): Promise<Row> {
  const [rows] = await conn.query<Row[]>(
    `SELECT * FROM payroll_runs WHERE company_id = ? AND id = ? FOR UPDATE`, [companyId, runId]);
  if (!rows.length) throw ApiError.notFound('Payroll run not found');
  return rows[0];
}

function monthRange(year: number, month: number): { from: string; to: string } {
  return { from: startOfMonth(year, month), to: endOfMonth(year, month) };
}

const periodEnd = (run: Row): string =>
  endOfMonth(Number(run.period_year), Number(run.period_month));

/**
 * When the salary expense belongs: the last day of the payroll month, or today
 * if that month is still running. Accruing on a future date would be refused by
 * the posting engine — exactly right for a voucher, and exactly wrong as a
 * reason to block the current month's payroll.
 *
 * A month that has not STARTED is a different matter: there is no expense to
 * accrue yet, and dating it today would book next quarter's salary into this
 * one. That is refused outright.
 */
function accrualDate(run: Row): string {
  const start = startOfMonth(Number(run.period_year), Number(run.period_month));
  const end = periodEnd(run);
  const now = today();

  if (start > now)
    throw ApiError.badRequest(
      `Payroll for ${periodLabel(run)} cannot be approved yet — that month has not started`);

  return end <= now ? end : now;
}

const periodLabel = (run: Row): string =>
  `${run.period_year}-${String(run.period_month).padStart(2, '0')}`;
