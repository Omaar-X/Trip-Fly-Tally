import { lazy, Suspense, useEffect, useState } from 'react';
import {
  TrendingUp, TrendingDown, Wallet, ReceiptText,
  Plane, Activity, DollarSign, LayoutDashboard,
} from 'lucide-react';
import { api } from '../api/client';
import { StatCard, Spinner, PageHeader, Badge, statusTone } from '../components/ui';
import { bdt, compactBdt, fmtDate } from '../lib/format';
import type { MonthPoint, TypeSlice } from './dashboard/DashboardCharts';

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

export default function Dashboard() {
  const [summary, setSummary]   = useState<Summary | null>(null);
  const [monthly, setMonthly]   = useState<MonthPoint[]>([]);
  const [byType, setByType]     = useState<TypeSlice[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
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
    </div>
  );
}
