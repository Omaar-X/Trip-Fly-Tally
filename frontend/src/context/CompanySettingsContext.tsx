import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { api } from '../api/client';
import { useAuth } from './AuthContext';

/** '2026-2027' plus the dates it spans — derived by the API from fy_start_month. */
export interface FinancialYear {
  label: string;
  from: string;
  to: string;
}

export interface Company {
  id: number;
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logo_url: string | null;
  favicon_url: string | null;
  vat_reg_no: string | null;
  tax_number: string | null;
  trade_license: string | null;
  currency: string;
  /** First month of the financial year — 7 for Bangladesh's July–June year. */
  fy_start_month: number;
  /** Earliest postable date. Opening balances are the position the day before. */
  books_begin_from: string | null;
  /** Everything on or before this date is frozen. */
  books_locked_upto: string | null;
  financial_year: FinancialYear;
  /** True once any voucher exists — the financial-year fields are frozen from then on. */
  has_postings: boolean;
  is_configured: 0 | 1;
}

interface CompanySettingsCtx {
  company: Company | null;
  loading: boolean;
  needsSetup: boolean;
  refresh: () => Promise<void>;
}

const Ctx = createContext<CompanySettingsCtx>(null as never);
export const useCompanySettings = () => useContext(Ctx);

export function CompanySettingsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) { setCompany(null); setLoading(false); return; }
    setLoading(true);
    try {
      const { data } = await api.get('/api/company-settings');
      setCompany(data.data);
    } catch {
      setCompany(null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { refresh(); }, [refresh]);

  const needsSetup = !!user && !!company && !company.is_configured;

  return <Ctx.Provider value={{ company, loading, needsSetup, refresh }}>{children}</Ctx.Provider>;
}
