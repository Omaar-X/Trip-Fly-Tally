import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import { Plane } from 'lucide-react';
import { bdt, compactBdt } from '../../lib/format';

/**
 * The dashboard's two charts, split out so the charting library can be loaded
 * SEPARATELY from the page around it.
 *
 * Recharts is 417 KB raw / 109 KB gzipped — on its own larger than every other
 * page in the app combined, and it sat in the first chunk a user downloads
 * after logging in. Pulled out here and mounted lazily, the dashboard's
 * figures, tiles and activity feed render on the smaller bundle while the
 * charts stream in behind them.
 */

export interface MonthPoint { month: string; revenue: number; expense: number; profit: number }
export interface TypeSlice { bookingType: string; total: number }

const SLICE_COLORS = ['#0f766e', '#14b8a6', '#f59e0b', '#64748b', '#6366f1'];

const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3 shadow-card-md text-xs">
      <p className="mb-1.5 font-semibold text-slate-600 dark:text-slate-300">{label}</p>
      {payload.map((p: any) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="text-slate-500 dark:text-slate-400">{p.name}:</span>
          <span className="num font-semibold">{bdt(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
};

export function RevenueExpenseChart({ monthly }: { monthly: MonthPoint[] }) {
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={monthly} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <defs>
            <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#0f766e" stopOpacity={0.3} />
              <stop offset="100%" stopColor="#0f766e" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="gExp" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#f59e0b" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" className="stroke-slate-100 dark:stroke-slate-800" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={(v) => compactBdt(Number(v))} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={68} />
          <Tooltip content={<ChartTooltip />} />
          <Area type="monotone" dataKey="revenue" name="Revenue" stroke="#0f766e" fill="url(#gRev)" strokeWidth={2.5} dot={false} />
          <Area type="monotone" dataKey="expense" name="Expenses" stroke="#f59e0b" fill="url(#gExp)" strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RevenueByTypeChart({ byType }: { byType: TypeSlice[] }) {
  if (byType.length === 0) {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-2">
        <Plane className="h-8 w-8 text-slate-300 dark:text-slate-700" />
        <p className="text-sm text-slate-400 dark:text-slate-500">No confirmed bookings yet</p>
      </div>
    );
  }
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={byType} dataKey="total" nameKey="bookingType"
               innerRadius={52} outerRadius={80} paddingAngle={4} strokeWidth={0}>
            {byType.map((_, i) => <Cell key={i} fill={SLICE_COLORS[i % SLICE_COLORS.length]} />)}
          </Pie>
          <Tooltip
            formatter={(v) => bdt(Number(v))}
            contentStyle={{ borderRadius: 12, fontSize: 12, border: '1px solid #e2e8f0' }}
          />
          <Legend formatter={(v) => <span className="text-xs">{v}</span>} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
