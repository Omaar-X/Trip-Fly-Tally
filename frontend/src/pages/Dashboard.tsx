import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import {
  TrendingUp, TrendingDown, Wallet, ReceiptText,
  Plane, Activity, DollarSign, LayoutDashboard, FileSpreadsheet, Scale,
} from 'lucide-react';
import { api } from '../api/client';
import { StatCard, Spinner, PageHeader, Badge, statusTone } from '../components/ui';
import { bdt, compactBdt, fmtDate } from '../lib/format';
import { ROLE, hasAnyRole } from '../lib/roles';
import { useAuth } from '../context/AuthContext';
import type { MonthPoint, TypeSlice } from './dashboard/DashboardCharts';

// Only the accounting side of the house sees the sales archive, so its section
// and its two KPI cards are loaded only for the roles that can reach the API.
const PreviousSalesData = lazy(() => import('./dashboard/PreviousSalesData'));
const AccountsReceivable = lazy(() => import('./dashboard/AccountsReceivable'));

// Recharts alone weighs more than every other page put together, and this is
// the first screen after login. Loading it lazily lets the figures, tiles and
// activity feed paint on the small bundle while the charts arrive behind them.
const RevenueExpenseChart = lazy(() =>
  import('./dashboard/DashboardCharts').then((m) => ({ default: m.RevenueExpenseChart })));
const RevenueByTypeChart = lazy(() =>
  import('./dashboard/DashboardCharts').then((m) => ({ default: m.RevenueByTypeChart })));

const ChartFallback = () => (
  <div className="flex h-64 items-center justify-center"><Spinner /></div>
);

interface Summary {
  revenueYtd: number; expensesYtd: number; netProfitYtd: number;
  receivables: number; cashAndBank: number;
  bookingsThisMonth: { status: string; count: number }[];
}
interface ActivityRow { id: number; user_name: string; action: string; entity: string; created_at: string }

/** What the archived sales sheets say, which is not what the ledgers say. */
interface SalesBalance {
  asOfLabel: string | null;
  openingBalance: number;
  runningBalance: number;
  movementSince: number;
  sheetsCounted: number;
  /** The ACCOUNTS sheet's own receivable — a different question, different source. */
  statedReceivable: number | null;
  statedReceivableLabel: string | null;
  /** The ACCOUNTS sheet's own SALES figure for the same month. */
  statedSales: number | null;
  /** The month's bottom line, as that sheet states it. */
  statedProfit: number | null;
  statedLoss: number | null;
}

export default function Dashboard() {
  const { user } = useAuth();
  const seesSalesArchive = hasAnyRole(user?.role, [ROLE.ADMIN, ROLE.ACCOUNTANT]);

  const [summary, setSummary]   = useState<Summary | null>(null);
  const [monthly, setMonthly]   = useState<MonthPoint[]>([]);
  const [byType, setByType]     = useState<TypeSlice[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [salesBalance, setSalesBalance] = useState<SalesBalance | null>(null);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/api/dashboard/summary'),
      api.get('/api/dashboard/monthly'),
      api.get('/api/dashboard/revenue-by-type'),
      api.get('/api/dashboard/activity'),
    ])
      .then(([s, m, t, a]) => {
        setSummary(s.data.data);
        setMonthly(m.data.data);
        setByType(t.data.data);
        setActivity(a.data.data);
      })
      .finally(() => setLoading(false));
  }, []);

  // Kept out of the Promise.all above on purpose: this call 403s for Sales and
  // HR, and a rejection there would blank the whole dashboard for them.
  const loadSalesBalance = useCallback(() => {
    if (!seesSalesArchive) return;
    api.get('/api/sales-files/balance')
      .then((r) => setSalesBalance(r.data.data))
      .catch(() => setSalesBalance(null));
  }, [seesSalesArchive]);

  useEffect(() => { loadSalesBalance(); }, [loadSalesBalance]);

  if (loading) {
    return (
      <div className="flex h-72 items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Spinner size="lg" />
          <p className="text-sm text-slate-400">Loading dashboard…</p>
        </div>
      </div>
    );
  }
  if (!summary) return null;

  const bookings    = summary.bookingsThisMonth ?? [];
  const totalBook   = bookings.reduce((s, b) => s + Number(b.count), 0);
  const profitPct   = summary.revenueYtd > 0
    ? Math.round((summary.netProfitYtd / summary.revenueYtd) * 100)
    : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard"
        icon={LayoutDashboard}
        sub="Live financial snapshot — revenue, expenses, bookings, and activity."
      />

      {/* ── KPI cards ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          accent
          color="brand"
          icon={TrendingUp}
          label="Net Profit (YTD)"
          value={bdt(summary.netProfitYtd)}
          sub={`${profitPct}% profit margin`}
        />
        <StatCard
          color="emerald"
          icon={DollarSign}
          label="Revenue (YTD)"
          value={bdt(summary.revenueYtd)}
          sub="All income ledgers"
        />
        <StatCard
          color="rose"
          icon={TrendingDown}
          label="Expenses (YTD)"
          value={bdt(summary.expensesYtd)}
          sub="All expense ledgers"
        />
        <StatCard
          color="blue"
          icon={Wallet}
          label="Cash & Bank"
          value={bdt(summary.cashAndBank)}
          sub={`Receivables ${compactBdt(summary.receivables)}`}
        />
      </div>

      {/* ── Sales archive KPI cards ──
          Deliberately a separate row from the four above. Those come from the
          posted ledgers; these come from the Excel sheets, and putting them
          side by side would invite the two to be read as one set of figures.

          The two say different things on purpose. The first is what the latest
          month BILLED; the second is what is still OWED, off that month's
          ACCOUNTS balance sheet. An earlier version derived the second from the
          first by subtracting the receipts the registers happen to record, and
          overstated the debt roughly eightfold — the registers do not record
          collection at all. */}
      {seesSalesArchive && salesBalance && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {/* The office's own SALES figure, not the sum of the register's
              rows. The two disagree — July-2026 is written up as 19,113,906
              where the rows add to 19,352,631 — and theirs is the one they
              will recognise, so the computed sum is shown underneath as a
              cross-check rather than in place of it. */}
          <StatCard
            color="amber"
            icon={FileSpreadsheet}
            label="Sales"
            value={bdt(salesBalance.statedSales ?? salesBalance.openingBalance)}
            sub={salesBalance.asOfLabel
              ? (salesBalance.statedSales === null
                  ? `${salesBalance.asOfLabel} — summed from the sales register`
                  : `${salesBalance.asOfLabel} — per the ACCOUNTS sheet`
                    + (Math.abs(salesBalance.statedSales - salesBalance.openingBalance) >= 1
                        ? ` · register rows add to ${bdt(salesBalance.openingBalance)}`
                        : ''))
              : 'No sales sheets imported yet'}
          />
          <StatCard
            color="rose"
            icon={Scale}
            label="Outstanding Receivable"
            value={salesBalance.statedReceivable === null
              ? '—' : bdt(salesBalance.statedReceivable)}
            sub={salesBalance.statedReceivableLabel
              ? `As at ${salesBalance.statedReceivableLabel}, per the ACCOUNTS sheet`
              : 'No balance sheet imported yet'}
          />

          {/* The month's bottom line off the same sheet. Distinct from the
              "Net Profit (YTD)" card in the row above, which comes from the
              posted ledgers and reads 0.00 because this archive posts nothing.
              Both are shown so neither has to stand in for the other. */}
          <StatCard
            color={(salesBalance.statedProfit ?? 0) >= 0 ? 'emerald' : 'rose'}
            icon={TrendingUp}
            label={salesBalance.statedProfit !== null ? 'Net Profit (sheet)' : 'Net Loss (sheet)'}
            value={salesBalance.statedProfit !== null
              ? bdt(salesBalance.statedProfit)
              : (salesBalance.statedLoss !== null ? bdt(salesBalance.statedLoss) : '—')}
            sub={salesBalance.statedReceivableLabel
              ? `${salesBalance.statedReceivableLabel} — per the ACCOUNTS sheet`
                + (salesBalance.statedProfit !== null && salesBalance.statedLoss !== null
                    ? ` · that sheet also carries a net loss line of ${bdt(salesBalance.statedLoss)}`
                    : '')
              : 'No balance sheet imported yet'}
          />
        </div>
      )}

      {/* ── Charts row ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">

        {/* Area chart */}
        <div className="card p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-bold">Revenue vs Expenses</h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Last 12 months</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-brand-600" />Revenue</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-400" />Expenses</span>
            </div>
          </div>
          <Suspense fallback={<ChartFallback />}>
            <RevenueExpenseChart monthly={monthly} />
          </Suspense>
        </div>

        {/* Pie chart */}
        <div className="card p-5">
          <div>
            <h2 className="font-bold">Revenue by Service</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Confirmed bookings</p>
          </div>
          <Suspense fallback={<ChartFallback />}>
            <RevenueByTypeChart byType={byType} />
          </Suspense>
        </div>
      </div>

      {/* ── Accounts receivable ──
          Below the charts and above the operational tiles: it is a statement
          about the book, not about this month's activity. */}
      {seesSalesArchive && (
        <Suspense fallback={<ChartFallback />}>
          <AccountsReceivable />
        </Suspense>
      )}

      {/* ── Bottom row ── */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">

        {/* Bookings this month */}
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-bold">Bookings This Month</h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{totalBook} total</p>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-50 dark:bg-brand-950">
              <Plane className="h-4 w-4 text-brand-600 dark:text-brand-400" />
            </div>
          </div>

          {totalBook === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
              No bookings this month yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {bookings.map((b, index) => (
                <li key={`${b.status}-${index}`} className="flex items-center justify-between rounded-xl border border-slate-100 dark:border-slate-800 px-4 py-2.5">
                  <Badge tone={statusTone(b.status)}>{b.status}</Badge>
                  <span className="num text-sm font-bold">{b.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Recent activity */}
        <div className="card p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-bold">Recent Activity</h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Audit trail</p>
            </div>
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800">
              <Activity className="h-4 w-4 text-slate-500 dark:text-slate-400" />
            </div>
          </div>

          {activity.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400 dark:text-slate-500">
              No activity recorded yet.
            </p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800/60">
              {activity.map((a) => (
                <li key={a.id} className="flex items-center gap-3 py-3 text-sm">
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400">
                    <ReceiptText className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold">{a.user_name ?? 'System'}</span>{' '}
                    <span className="text-slate-500 dark:text-slate-400">
                      {a.action.toLowerCase().replaceAll('_', ' ')}
                    </span>{' '}
                    <span className="font-medium text-brand-700 dark:text-brand-300">{a.entity}</span>
                  </div>
                  <span className="num flex-shrink-0 text-xs text-slate-400 dark:text-slate-500">
                    {fmtDate(a.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ── Previous sales data ── */}
      {seesSalesArchive && (
        <Suspense fallback={<ChartFallback />}>
          <PreviousSalesData onImported={loadSalesBalance} />
        </Suspense>
      )}
    </div>
  );
}
