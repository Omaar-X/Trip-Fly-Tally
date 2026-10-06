import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, FolderClock, RefreshCw } from 'lucide-react';
import { api, apiErrorMessage } from '../../api/client';
import { Badge, ErrorNote, Money, Spinner } from '../../components/ui';
import { ROLE, hasAnyRole } from '../../lib/roles';
import { useAuth } from '../../context/AuthContext';

/**
 * ======================== PREVIOUS SALES DATA ==============================
 *
 * The archive of the monthly Excel workbooks, on the dashboard: one row per
 * sheet, filterable by month and party, with the original file a click away.
 *
 * Two columns exist because the archive is honest about duplicates rather
 * than hiding them. A month's register is copied into the next month's
 * workbook, and a party ledger restates its whole history in every workbook it
 * appears in. Both copies are listed — you can download either — but only the
 * one marked as counting feeds the balance above, and the badges say which is
 * which instead of leaving a reader to wonder why two rows disagree.
 */

interface SalesFile {
  id: number;
  file_name: string;
  sheet_name: string;
  sheet_shape: 'SALES_REGISTER' | 'PARTY_LEDGER';
  month_label: string;
  month_year: string;
  is_primary: 0 | 1;
  is_cumulative: 0 | 1;
  period_from: string | null;
  period_to: string | null;
  customer_name: string | null;
  total_tickets: number;
  total_debit: string | number;
  total_credit: string | number;
  closing_balance: string | number;
}

interface ScanSummary {
  filesSeen: number;
  filesProcessed: number;
  filesUnchanged: number;
  filesFailed: number;
  sheetsImported: number;
  rowsAdded: number;
  bookingsCreated: number;
  customersCreated: number;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** A full archive scan opens 27 workbooks and raises a few thousand bookings. */
const SCAN_TIMEOUT_MS = 15 * 60 * 1000;

export default function PreviousSalesData({ onImported }: { onImported?: () => void }) {
  const { user } = useAuth();
  const canScan = hasAnyRole(user?.role, [ROLE.ADMIN]);

  const [files, setFiles] = useState<SalesFile[]>([]);
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [customer, setCustomer] = useState('');
  const [applied, setApplied] = useState('');          // the customer term in force
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/api/sales-files', {
        params: {
          year: year || undefined,
          month: month || undefined,
          customer: applied || undefined,
        },
      });
      setFiles(data.data);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [year, month, applied]);

  useEffect(() => { void load(); }, [load]);

  const years = useMemo(() => {
    const found = new Set(files.map((f) => f.month_year.slice(0, 4)));
    // The dropdown must keep offering the year currently filtered on, or
    // picking one would empty the list and then hide the way back out of it.
    if (year) found.add(year);
    return [...found].sort().reverse();
  }, [files, year]);

  const scan = async () => {
    setScanning(true);
    setError(null);
    setScanResult(null);
    try {
      const { data } = await api.post('/api/sales-files/scan', {}, { timeout: SCAN_TIMEOUT_MS });
      setScanResult(data.data);
      await load();
      onImported?.();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setScanning(false);
    }
  };

  /**
   * The download goes through the API client, not a bare link, because the
   * route needs the bearer token. The blob is released on the next tick —
   * revoking it synchronously cancels the download in Firefox.
   */
  const download = async (file: SalesFile) => {
    setError(null);
    try {
      const res = await api.get(`/api/sales-files/${file.id}/download`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data as Blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.file_name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const clear = () => { setYear(''); setMonth(''); setCustomer(''); setApplied(''); };
  const filtered = year || month || applied;

  return (
    <div className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-50 dark:bg-brand-950">
            <FolderClock className="h-4 w-4 text-brand-600 dark:text-brand-400" />
          </div>
          <div>
            <h2 className="font-bold">Previous Sales Data</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Original monthly workbooks, as the office wrote them.
            </p>
          </div>
        </div>

        {canScan && (
          <button className="btn btn-primary" onClick={scan} disabled={scanning}>
            {scanning ? <Spinner size="sm" /> : <RefreshCw className="h-4 w-4" />}
            {scanning ? 'Importing…' : 'Scan & Import All'}
          </button>
        )}
      </div>

      {scanning && (
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          Reading every workbook in the archive folder — about half a minute for
          the full set. Workbooks unchanged since the last scan are skipped, and
          a ticket already imported never becomes a second booking.
        </p>
      )}

      {scanResult && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm
                        dark:border-emerald-900 dark:bg-emerald-950/40">
          <span className="font-semibold text-emerald-800 dark:text-emerald-300">Import finished.</span>{' '}
          <span className="text-emerald-700 dark:text-emerald-400">
            {scanResult.filesSeen} workbooks seen · {scanResult.filesProcessed} read ·{' '}
            {scanResult.filesUnchanged} unchanged · {scanResult.sheetsImported} sheets ·{' '}
            {scanResult.rowsAdded} rows · {scanResult.bookingsCreated} bookings ·{' '}
            {scanResult.customersCreated} new customers
            {scanResult.filesFailed > 0 && ` · ${scanResult.filesFailed} failed`}
          </span>
        </div>
      )}

      <ErrorNote message={error} />

      {/* ── filters ── */}
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <select className="select !w-auto" value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="">All years</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>

        <select className="select !w-auto" value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">All months</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={String(i + 1)}>{m}</option>
          ))}
        </select>

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => { e.preventDefault(); setApplied(customer.trim()); }}
        >
          <input
            className="input !w-auto"
            placeholder="Customer / party…"
            value={customer}
            onChange={(e) => setCustomer(e.target.value)}
          />
          <button className="btn btn-ghost" type="submit">Search</button>
        </form>

        {filtered && (
          <button className="btn btn-ghost" onClick={clear}>Clear</button>
        )}
      </div>

      {/* ── table ── */}
      {loading ? (
        <div className="flex h-32 items-center justify-center"><Spinner /></div>
      ) : files.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
          {filtered
            ? 'No sheets match these filters.'
            : canScan
              ? 'Nothing imported yet — press “Scan & Import All”.'
              : 'Nothing imported yet.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr>
                <th className="th">Month</th>
                <th className="th">Customer / Sheet</th>
                <th className="th text-right">Tickets</th>
                <th className="th text-right">Total Sales</th>
                <th className="th text-right">Total Received</th>
                <th className="th text-right">Balance</th>
                <th className="th text-right">Download</th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => {
                const balance = Number(f.closing_balance);
                return (
                  <tr key={f.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="td whitespace-nowrap font-semibold">{f.month_label}</td>
                    <td className="td">
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{f.customer_name ?? f.sheet_name}</span>
                        {f.is_cumulative === 1 && <Badge tone="blue">running total</Badge>}
                        {f.is_primary === 0 && <Badge tone="slate">duplicate copy</Badge>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                        {f.file_name} · {f.sheet_name}
                      </div>
                    </td>
                    <td className="td num text-right">{f.total_tickets}</td>
                    <td className="td text-right"><Money value={f.total_debit} /></td>
                    <td className="td text-right"><Money value={f.total_credit} /></td>
                    <td className={`td text-right font-semibold ${
                      balance >= 0
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-rose-600 dark:text-rose-400'}`}>
                      <Money value={balance} />
                    </td>
                    <td className="td text-right">
                      <button
                        className="btn btn-ghost !px-2 !py-1 text-xs"
                        onClick={() => download(f)}
                        title={`Download ${f.file_name}`}
                      >
                        <Download className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
