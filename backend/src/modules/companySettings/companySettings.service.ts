import { query, exec, Row } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import {
  assertLockDateUsable, currentFinancialYear, toPolicy, FinancialYear,
} from '../accounting/fiscalPeriod.service';

/** True once anything at all has been posted to the books. */
async function hasPostings(companyId: number): Promise<boolean> {
  const rows = await query<Row[]>(
    'SELECT 1 AS found FROM vouchers WHERE company_id = ? LIMIT 1', [companyId]);
  return rows.length > 0;
}

export interface CompanySettingsInput {
  name: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  vatRegNo?: string;
  taxNumber?: string;
  tradeLicense?: string;
  currency?: string;
  /** First month of the financial year — Bangladesh runs July–June, so 7. */
  fyStartMonth?: number;
  /** Earliest date a voucher may carry. Openings are the position the day before. */
  booksBeginFrom?: string;
}

/** A company row plus the derived facts every caller wants alongside it. */
export type CompanySettings = Row & {
  financial_year: FinancialYear;
  has_postings: boolean;
};

export const companySettingsService = {
  async get(companyId: number): Promise<CompanySettings> {
    const rows = await query<Row[]>('SELECT * FROM companies WHERE id = ?', [companyId]);
    if (!rows[0]) throw ApiError.notFound('Company not found');
    const policy = toPolicy(rows[0]);
    return Object.assign(rows[0], {
      // The financial year the company is currently in, so callers never have
      // to re-derive it from fy_start_month.
      financial_year: currentFinancialYear(policy.fyStartMonth),
      // Whether the financial-year fields are still editable. The UI needs to
      // know before the user types, not after the save is rejected.
      has_postings: await hasPostings(companyId),
    });
  },

  /**
   * Move the period lock. Everything on or before `booksLockedUpto` becomes
   * unpostable; passing null reopens the books entirely.
   *
   * Reopening is deliberately allowed — a lock is a control, not a one-way
   * door — but it is CEO-only and audited, so a reopened period leaves a trail.
   */
  async setPeriodLock(companyId: number, lockDate: string | null) {
    const current = await this.get(companyId);
    assertLockDateUsable(lockDate, toPolicy(current));
    await exec('UPDATE companies SET books_locked_upto = ? WHERE id = ?', [lockDate, companyId]);
    return this.get(companyId);
  },

  /** Unauthenticated branding only — no address/phone/tax data. */
  async getPublic(companyId: number) {
    const rows = await query<Row[]>('SELECT name, logo_url, favicon_url FROM companies WHERE id = ?', [companyId]);
    return rows[0] ?? { name: 'Company', logo_url: null, favicon_url: null };
  },

  async update(companyId: number, input: CompanySettingsInput) {
    const current = await this.get(companyId);

    // Once anything has been posted, the financial-year start and the date the
    // books begin are frozen: moving either would re-file existing vouchers
    // into different years and re-interpret every opening balance. They are
    // set during first-time setup and left alone after that.
    if (input.fyStartMonth !== undefined || input.booksBeginFrom !== undefined) {
      const changed =
        (input.fyStartMonth !== undefined && input.fyStartMonth !== Number(current.fy_start_month)) ||
        (input.booksBeginFrom !== undefined && input.booksBeginFrom !== current.books_begin_from);
      if (changed && current.has_postings)
        throw ApiError.conflict(
          'The financial year and the books-begin date cannot be changed once vouchers exist — ' +
          'every posted voucher and opening balance is interpreted against them.');
    }

    await exec(
      `UPDATE companies SET
         name = ?, address = ?, phone = ?, email = ?, website = ?,
         vat_reg_no = ?, tax_number = ?, trade_license = ?, currency = ?,
         fy_start_month = ?, books_begin_from = ?,
         is_configured = 1
       WHERE id = ?`,
      [
        input.name, input.address ?? null, input.phone ?? null, input.email ?? null, input.website ?? null,
        input.vatRegNo ?? null, input.taxNumber ?? null, input.tradeLicense ?? null, input.currency ?? 'BDT',
        input.fyStartMonth ?? Number(current.fy_start_month) ?? 7,
        input.booksBeginFrom ?? current.books_begin_from ?? null,
        companyId,
      ]
    );
    return this.get(companyId);
  },

  async updateLogo(companyId: number, url: string) {
    await exec('UPDATE companies SET logo_url = ? WHERE id = ?', [url, companyId]);
    return this.get(companyId);
  },

  async updateFavicon(companyId: number, url: string) {
    await exec('UPDATE companies SET favicon_url = ? WHERE id = ?', [url, companyId]);
    return this.get(companyId);
  },
};
