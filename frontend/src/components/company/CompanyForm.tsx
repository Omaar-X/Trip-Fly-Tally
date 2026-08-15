import { ChangeEvent, FormEvent, useState } from 'react';
import { Building2, Upload } from 'lucide-react';
import { api, apiErrorMessage, resolveAssetUrl } from '../../api/client';
import { useCompanySettings } from '../../context/CompanySettingsContext';
import { Field, ErrorNote } from '../ui';

interface FormState {
  name: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  vatRegNo: string;
  taxNumber: string;
  tradeLicense: string;
  currency: string;
  fyStartMonth: string;
  booksBeginFrom: string;
}

/** Bangladesh's financial year runs July–June, so month 7 is the default. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

const defaultBooksBeginFrom = (fyStartMonth: number): string => {
  const now = new Date();
  const year = now.getMonth() + 1 >= fyStartMonth ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String(fyStartMonth).padStart(2, '0')}-01`;
};

const emptyForm = (): FormState => ({
  name: '', address: '', phone: '', email: '', website: '',
  vatRegNo: '', taxNumber: '', tradeLicense: '', currency: 'BDT',
  fyStartMonth: '7', booksBeginFrom: defaultBooksBeginFrom(7),
});

export default function CompanyForm({ variant = 'settings', onSaved }: { variant?: 'wizard' | 'settings'; onSaved?: () => void }) {
  const { company, refresh } = useCompanySettings();
  const [form, setForm] = useState<FormState>(() => company ? {
    name: company.name ?? '', address: company.address ?? '', phone: company.phone ?? '',
    email: company.email ?? '', website: company.website ?? '', vatRegNo: company.vat_reg_no ?? '',
    taxNumber: company.tax_number ?? '', tradeLicense: company.trade_license ?? '', currency: company.currency ?? 'BDT',
    fyStartMonth: String(company.fy_start_month ?? 7),
    booksBeginFrom: company.books_begin_from ?? defaultBooksBeginFrom(company.fy_start_month ?? 7),
  } : emptyForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [faviconBusy, setFaviconBusy] = useState(false);

  // Once a voucher exists the financial year is settled: changing it would
  // re-file every posted voucher and re-read every opening balance.
  const locked = !!company?.has_postings;

  const set = <K extends keyof FormState>(key: K, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const body: Record<string, string | number> = {
        name: form.name, currency: form.currency,
        fyStartMonth: Number(form.fyStartMonth),
      };
      if (form.booksBeginFrom) body.booksBeginFrom = form.booksBeginFrom;
      for (const key of ['address', 'phone', 'email', 'website', 'vatRegNo', 'taxNumber', 'tradeLicense'] as const) {
        if (form[key]) body[key] = form[key];
      }
      await api.put('/api/company-settings', body);
      await refresh();
      onSaved?.();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  const uploadFile = async (
    e: ChangeEvent<HTMLInputElement>,
    field: 'logo' | 'favicon',
    setUploading: (b: boolean) => void
  ) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true); setError(null);
    try {
      const fd = new FormData();
      fd.append(field, file);
      await api.post(`/api/company-settings/${field}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await refresh();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setUploading(false); }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      {variant === 'wizard' && (
        <div className="flex items-center gap-3 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 dark:border-brand-900/50 dark:bg-brand-950/30">
          <Building2 className="h-5 w-5 flex-shrink-0 text-brand-600 dark:text-brand-400" />
          <p className="text-sm text-brand-800 dark:text-brand-200">
            Set up your company profile before continuing — this powers every invoice, payslip and report.
          </p>
        </div>
      )}

      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
          {company?.logo_url
            ? <img src={resolveAssetUrl(company.logo_url) ?? undefined} alt="Logo" className="h-full w-full object-contain" />
            : <Building2 className="h-6 w-6 text-slate-300 dark:text-slate-600" />}
        </div>
        <div className="flex gap-2">
          <label className="btn btn-ghost cursor-pointer">
            <Upload className="h-4 w-4" /> {logoBusy ? 'Uploading…' : 'Upload logo'}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden"
                   disabled={logoBusy} onChange={(e) => uploadFile(e, 'logo', setLogoBusy)} />
          </label>
          <label className="btn btn-ghost cursor-pointer">
            <Upload className="h-4 w-4" /> {faviconBusy ? 'Uploading…' : 'Upload favicon'}
            <input type="file" accept="image/png,image/x-icon" className="hidden"
                   disabled={faviconBusy} onChange={(e) => uploadFile(e, 'favicon', setFaviconBusy)} />
          </label>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Company name">
          <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} required minLength={2} />
        </Field>
        <Field label="Website">
          <input className="input" type="url" placeholder="https://example.com" value={form.website} onChange={(e) => set('website', e.target.value)} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Phone">
          <input className="input" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Address">
          <input className="input" value={form.address} onChange={(e) => set('address', e.target.value)} />
        </Field>
        <Field label="Currency">
          <input className="input" value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={10} />
        </Field>
        <Field label="VAT reg. no. (BIN)">
          <input className="input" value={form.vatRegNo} onChange={(e) => set('vatRegNo', e.target.value)} />
        </Field>
        <Field label="Tax number (TIN)" hint="Optional">
          <input className="input" value={form.taxNumber} onChange={(e) => set('taxNumber', e.target.value)} />
        </Field>
        <Field label="Trade license" hint="Optional">
          <input className="input" value={form.tradeLicense} onChange={(e) => set('tradeLicense', e.target.value)} />
        </Field>
      </div>

      {/* Financial year. Both fields decide how every voucher is numbered and
          how every opening balance is read, so they are frozen once the first
          voucher is posted — the API rejects a change after that. */}
      <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800">
        <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Financial year</h3>
        <p className="mb-3 text-xs text-slate-400">
          Fixed once the first voucher is posted — every voucher number and opening balance is read against these.
          {locked && ' Vouchers already exist, so these can no longer be changed.'}
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Year starts in" hint="Bangladesh runs July–June">
            <select className="input" value={form.fyStartMonth} disabled={locked}
              onChange={(e) => {
                set('fyStartMonth', e.target.value);
                set('booksBeginFrom', defaultBooksBeginFrom(Number(e.target.value)));
              }}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </Field>
          <Field label="Books begin from" hint="Opening balances are the position the day before">
            <input type="date" className="input num" value={form.booksBeginFrom} disabled={locked}
              onChange={(e) => set('booksBeginFrom', e.target.value)} />
          </Field>
        </div>
      </div>

      <ErrorNote message={error} />

      <div className="flex justify-end">
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : variant === 'wizard' ? 'Finish setup' : 'Save changes'}</button>
      </div>
    </form>
  );
}
