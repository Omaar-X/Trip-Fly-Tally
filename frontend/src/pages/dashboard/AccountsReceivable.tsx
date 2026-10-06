import { useEffect, useMemo, useState } from 'react';
import { Scale } from 'lucide-react';
import { api, apiErrorMessage } from '../../api/client';
import { Badge, Column, DataTable, ErrorNote, Money, Spinner } from '../../components/ui';
import { bdt } from '../../lib/format';

/**
 * ======================== ACCOUNTS RECEIVABLE ==============================
 *
 * Billed − received per party, out of the imported sales sheets, with spelling
 * variants folded together.
 *
 * OUTSTANDING comes from the ACCOUNTS RECEIVABLE block on the latest month's
 * balance sheet — the office's own list of who still owes. It is NOT billed
 * minus receipts over the sales rows: billing and collection live in different
 * sheets here, and that subtraction overstated the debt roughly eightfold.
 *
 * BILLED is context from a different source and a fixed window (the month
 * registers, MAR-2024 → JUL-2026), so COLLECTED is only shown where billed
 * covers the outstanding. A party carrying a balance from before the window
 * shows a dash rather than an invented negative receipt.
 */

type Status = 'PENDING' | 'RECEIVED';
type Tab = 'ALL' | Status;

interface ReceivableRow {
  customerName: string;
  variants: string[];
  outstanding: number;
  totalBilled: number | null;
  totalReceived: number | null;
  tickets: number;
  status: Status;
  carriedIn: boolean;
}

interface Receivables {
  totalOutstanding: number;
  sumOfLines: number;
  discrepancy: number | null;
  asOfMonth: string | null;
  asOfLabel: string | null;
  sourceFile: string | null;
  sourceSheet: string | null;
  totalBilled: number;
  customers: number;
  pending: number;
  received: number;
  periodFrom: string;
  periodTo: string;
  rows: ReceivableRow[];
}

/** An amount the archive cannot state, with the reason a hover away. */
const Dash = ({ title }: { title: string }) => (
  <span className="cursor-help text-slate-400 dark:text-slate-600" title={title}>—</span>
);

const monthOf = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB',
    { month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase();

export default function AccountsReceivable() {
  const [data, setData] = useState<Receivables | null>(null);
  const [tab, setTab] = useState<Tab>('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetched once, unfiltered. The endpoint takes a `status` filter too, but
  // this is a single small payload and switching tabs should not cost a round
  // trip — the totals in the header are the same either way.
  useEffect(() => {
    api.get('/api/sales-files/receivables')
      .then((r) => setData(r.data.data))
      .catch((err) => setError(apiErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  const rows = useMemo(
    () => (data ? data.rows.filter((r) => tab === 'ALL' || r.status === tab) : []),
    [data, tab]);

  const columns: Column<ReceivableRow>[] = [
    {
      key: 'customerName',
      header: 'Customer Name',
      render: (r) => (
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{r.customerName}</span>
          {r.variants.length > 0 && (
            <span
              className="cursor-help text-[11px] text-slate-400 dark:text-slate-500"
              title={`Also written as: ${r.variants.join(', ')}`}
            >
              +{r.variants.length} spelling{r.variants.length > 1 ? 's' : ''}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'tickets', header: 'Tickets', align: 'right',
      render: (r) => <span className="num">{r.tickets || '—'}</span>,
    },
    {
      key: 'totalBilled', header: 'Total Billed', align: 'right',
      sortValue: (r) => r.totalBilled ?? -1,
      render: (r) => (r.totalBilled === null
        ? <Dash title="Never billed in MAR-2024 – JUL-2026; the balance is carried in from before the window." />
        : <Money value={r.totalBilled} />),
    },
    {
      key: 'totalReceived', header: 'Total Received', align: 'right',
      sortValue: (r) => r.totalReceived ?? -1,
      render: (r) => (r.totalReceived === null
        ? <Dash title="Outstanding exceeds what was billed inside the window, so the balance predates it — subtracting would invent a negative receipt." />
        : <Money value={r.totalReceived} />),
    },
    {
      key: 'outstanding', header: 'Outstanding', align: 'right',
      render: (r) => (
        <span className={`font-semibold ${r.outstanding > 0
          ? 'text-rose-600 dark:text-rose-400'
          : 'text-emerald-600 dark:text-emerald-400'}`}>
          <Money value={r.outstanding} />
        </span>
      ),
    },
    {
      key: 'status', header: 'Status', sortable: false,
      render: (r) => (
        <div className="flex items-center gap-2">
          <Badge tone={r.status === 'RECEIVED' ? 'green' : 'amber'}>{r.status}</Badge>
          {r.carriedIn && <Badge tone="slate">carried in</Badge>}
        </div>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="card flex h-40 items-center justify-center p-5"><Spinner /></div>
    );
  }
  if (error) return <div className="card p-5"><ErrorNote message={error} /></div>;
  if (!data) return null;

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'ALL', label: 'ALL', count: data.customers },
    { id: 'PENDING', label: 'PENDING', count: data.pending },
    { id: 'RECEIVED', label: 'RECEIVED', count: data.received },
  ];

  return (
    <div className="space-y-4">
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-500/15 text-rose-600 dark:text-rose-400">
              <Scale className="h-[18px] w-[18px]" />
            </div>
            <div>
              <h2 className="font-bold">Accounts Receivable</h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {data.pending} of {data.customers} customers still owe · billed{' '}
                {bdt(data.totalBilled)} across {monthOf(data.periodFrom)} – {monthOf(data.periodTo)}
              </p>
            </div>
          </div>

          <div className="text-right">
            <div className="label">Total Outstanding</div>
            <div className="num mt-1 text-2xl font-bold text-rose-600 dark:text-rose-400">
              {bdt(data.totalOutstanding)}
            </div>
            <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              As at {data.asOfLabel}, per {data.sourceSheet} in {data.sourceFile}
            </div>
          </div>
        </div>

        {data.discrepancy !== null && (
          <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs
                        text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <span className="font-semibold">This month's block does not add up.</span>{' '}
            The party lines come to {bdt(data.sumOfLines)} against a stated total of{' '}
            {bdt(data.totalOutstanding)} — a difference of {bdt(data.discrepancy)}. The stated
            total is shown above; the gap is in the source sheet, not in this reading of it.
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition
                ${tab === t.id
                  ? 'bg-brand-950 text-white shadow'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}
            >
              {t.label}
              <span className={`num text-xs ${tab === t.id ? 'text-white/60' : 'text-slate-400'}`}>
                {t.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        empty={tab === 'RECEIVED'
          ? 'Every customer on the latest balance sheet still owes something.'
          : 'Nothing imported yet — run “Scan & Import All” below.'}
      />
    </div>
  );
}
