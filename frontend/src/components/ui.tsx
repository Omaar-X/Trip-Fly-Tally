import { ComponentType, ReactNode, useMemo, useState } from 'react';
import { Search, X, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Loader2, TrendingUp, TrendingDown } from 'lucide-react';
import { bdt } from '../lib/format';

// ─────────────────────────────── Money ──────────────────────────────────────

export const Money = ({ value, className = '' }: { value: number | string | null | undefined; className?: string }) => (
  <span className={`num ${className}`}>{bdt(Number(value ?? 0))}</span>
);

// ─────────────────────────────── Badge ──────────────────────────────────────

const TONE_MAP: Record<string, string> = {
  slate:   'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 ring-slate-200 dark:ring-slate-700',
  green:   'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 ring-emerald-200 dark:ring-emerald-800',
  amber:   'bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 ring-amber-200 dark:ring-amber-800',
  rose:    'bg-rose-50 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 ring-rose-200 dark:ring-rose-800',
  teal:    'bg-brand-50 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300 ring-brand-200 dark:ring-brand-800',
  blue:    'bg-sky-50 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300 ring-sky-200 dark:ring-sky-800',
  violet:  'bg-violet-50 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300 ring-violet-200 dark:ring-violet-800',
};

export function Badge({ children, tone = 'slate' }: { children: ReactNode; tone?: string }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ${TONE_MAP[tone] ?? TONE_MAP.slate}`}>
      {children}
    </span>
  );
}

export const statusTone = (s: string): string =>
  ({
    CONFIRMED: 'green', PAID: 'green', APPROVED: 'teal', PRESENT: 'green',
    PENDING: 'amber', PARTIAL: 'amber', DRAFT: 'amber', UNPAID: 'amber', HALF_DAY: 'amber', LEAVE: 'blue',
    CANCELLED: 'rose', VOID: 'rose', ABSENT: 'rose',
    IN: 'green', OUT: 'rose', DR: 'teal', CR: 'amber',
  } as Record<string, string>)[s] ?? 'slate';

// ─────────────────────────────── Spinner ────────────────────────────────────

export const Spinner = ({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) => {
  const sz = { sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-7 w-7' }[size];
  return <Loader2 className={`${sz} animate-spin text-brand-600`} />;
};

// ─────────────────────────────── StatCard ───────────────────────────────────

const STAT_COLORS = {
  brand:   { icon: 'bg-brand-500/15 text-brand-600 dark:text-brand-400',   grad: 'from-brand-600 to-brand-800' },
  emerald: { icon: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400', grad: 'from-emerald-500 to-emerald-700' },
  rose:    { icon: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',       grad: 'from-rose-500 to-rose-700' },
  amber:   { icon: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',    grad: 'from-amber-500 to-amber-700' },
  blue:    { icon: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',          grad: 'from-sky-500 to-sky-700' },
};

export function StatCard({
  label, value, sub, accent = false,
  icon: Icon,
  color = 'brand',
  trend, trendLabel,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
  icon?: ComponentType<{ className?: string }>;
  color?: keyof typeof STAT_COLORS;
  trend?: number;
  trendLabel?: string;
}) {
  const palette = STAT_COLORS[color] ?? STAT_COLORS.brand;

  if (accent) {
    return (
      <div className={`relative overflow-hidden rounded-2xl p-5 bg-gradient-to-br ${palette.grad} text-white shadow-card-md`}>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_top_right,_rgb(255_255_255/0.14),_transparent)]" />
        <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-white/5" />
        {Icon && (
          <div className="relative mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/20">
            <Icon className="h-[18px] w-[18px]" />
          </div>
        )}
        <div className="relative text-[10px] font-bold uppercase tracking-[0.12em] text-white/70">{label}</div>
        <div className="relative num mt-1.5 text-2xl font-bold">{value}</div>
        {sub && <div className="relative mt-1.5 text-xs text-white/60">{sub}</div>}
        {trend !== undefined && (
          <div className="relative mt-2 inline-flex items-center gap-1 text-xs font-semibold text-white/80">
            {trend >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
            {trend >= 0 ? '+' : ''}{trend}%{trendLabel ? ` ${trendLabel}` : ''}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card p-5">
      {Icon && (
        <div className={`mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl ${palette.icon}`}>
          <Icon className="h-[18px] w-[18px]" />
        </div>
      )}
      <div className="label">{label}</div>
      <div className="num mt-1.5 text-2xl font-bold text-slate-800 dark:text-slate-100">{value}</div>
      {sub && <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{sub}</div>}
      {trend !== undefined && (
        <div className="mt-2 inline-flex items-center gap-1 text-xs font-semibold">
          {trend >= 0
            ? <><TrendingUp className="h-3.5 w-3.5 text-emerald-500" /><span className="text-emerald-600 dark:text-emerald-400">+{trend}%</span></>
            : <><TrendingDown className="h-3.5 w-3.5 text-rose-500" /><span className="text-rose-600 dark:text-rose-400">{trend}%</span></>}
          {trendLabel && <span className="text-slate-400 dark:text-slate-500 font-normal">{trendLabel}</span>}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── PageHeader ─────────────────────────────────

export function PageHeader({
  title, sub, actions, icon: Icon,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-center gap-3">
        {Icon && (
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-500/12 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400">
            <Icon className="h-5 w-5" />
          </div>
        )}
        <div>
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          {sub && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{sub}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

// ─────────────────────────────── Field ──────────────────────────────────────

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-slate-400 dark:text-slate-500">{hint}</span>}
    </label>
  );
}

// ─────────────────────────────── Modal ──────────────────────────────────────

export function Modal({
  open, onClose, title, children, wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/60 px-4 py-8 backdrop-blur-sm animate-fade-in"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`card w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} p-6 animate-scale-in shadow-card-lg`}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <h2 className="text-lg font-bold leading-tight">{title}</h2>
          <button
            onClick={onClose}
            className="flex-shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─────────────────────────────── ErrorNote ──────────────────────────────────

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300">
      {message}
    </div>
  );
}

// ─────────────────────────────── DataTable ──────────────────────────────────

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right';
  sortValue?: (row: T) => string | number;
  /** Set false for action columns and anything the API cannot sort by. */
  sortable?: boolean;
}

/**
 * Server-driven paging. Supply this when the list can outgrow one screen.
 *
 * Everything then happens on the server: the page, the sort AND the search.
 * Doing any of it in the browser would only act on the rows already fetched
 * while looking like it acted on all of them — sorting page one by amount and
 * calling the top row "the largest invoice" is a wrong answer delivered with a
 * straight face.
 */
export interface ServerPaging {
  page: number;
  pageSize: number;
  total: number;
  sort: { key: string; dir: 1 | -1 } | null;
  q: string;
  onPage: (page: number) => void;
  onSort: (sort: { key: string; dir: 1 | -1 }) => void;
  onQ: (q: string) => void;
}

export function DataTable<T extends Record<string, any>>({
  columns, rows, loading, searchable = true,
  empty = 'Nothing here yet.', footer, paging,
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  searchable?: boolean;
  empty?: string;
  footer?: ReactNode;
  paging?: ServerPaging;
}) {
  const [localQ, setLocalQ] = useState('');
  const [localSort, setLocalSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  const server = !!paging;
  const q = server ? paging!.q : localQ;
  const sort = server ? paging!.sort : localSort;

  // In server mode the rows ARE the page: no local filtering or sorting, or
  // the table would quietly disagree with the header it just rendered.
  const view = useMemo(() => {
    if (server) return rows;
    let out = rows;
    if (localQ.trim()) {
      const needle = localQ.toLowerCase();
      out = out.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
    }
    if (localSort) {
      const col = columns.find((c) => c.key === localSort.key);
      out = [...out].sort((a, b) => {
        const av = col?.sortValue ? col.sortValue(a) : a[localSort.key];
        const bv = col?.sortValue ? col.sortValue(b) : b[localSort.key];
        return (av > bv ? 1 : av < bv ? -1 : 0) * localSort.dir;
      });
    }
    return out;
  }, [server, rows, localQ, localSort, columns]);

  const setQ = (value: string) => (server ? paging!.onQ(value) : setLocalQ(value));
  const toggleSort = (key: string) => {
    const next: { key: string; dir: 1 | -1 } =
      sort?.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: 1 };
    if (server) paging!.onSort(next); else setLocalSort(next);
  };

  const firstRow = server && paging!.total ? (paging!.page - 1) * paging!.pageSize + 1 : 0;
  const lastRow = server ? Math.min(paging!.page * paging!.pageSize, paging!.total) : 0;
  const lastPage = server ? Math.max(1, Math.ceil(paging!.total / paging!.pageSize)) : 1;

  return (
    <div className="card overflow-hidden">
      {searchable && (
        <div className="flex items-center gap-3 border-b border-slate-100 dark:border-slate-800 px-4 py-3 bg-slate-50/60 dark:bg-slate-800/30">
          <Search className="h-4 w-4 flex-shrink-0 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={server ? 'Search all records…' : 'Filter rows…'}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400 dark:placeholder:text-slate-600"
          />
          {/* In server mode this counts EVERYTHING that matches, not just the
              rows on screen. It used to read "300/300" on a book of 5,000. */}
          <span className="num flex-shrink-0 rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            {server ? paging!.total.toLocaleString() : `${view.length}/${rows.length}`}
          </span>
          {q && (
            <button onClick={() => setQ('')} className="flex-shrink-0 rounded p-0.5 hover:text-slate-600 dark:hover:text-slate-200 text-slate-400">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50/80 dark:bg-slate-800/40">
              {columns.map((c) => {
                const canSort = c.sortable !== false && c.header !== '';
                return (
                  <th
                    key={c.key}
                    className={`th select-none transition-colors ${c.align === 'right' ? 'text-right' : ''} ${
                      canSort ? 'cursor-pointer hover:text-slate-700 dark:hover:text-slate-200' : ''}`}
                    onClick={canSort ? () => toggleSort(c.key) : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.header}
                      {canSort && (
                        <span className="opacity-40">
                          {sort?.key === c.key
                            ? sort.dir === 1
                              ? <ChevronUp className="h-3 w-3" />
                              : <ChevronDown className="h-3 w-3" />
                            : <ChevronUp className="h-3 w-3 opacity-0 group-hover:opacity-100" />}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="td py-16 text-center" colSpan={columns.length}>
                  <span className="inline-flex items-center gap-2.5 text-slate-500">
                    <Spinner /> <span className="text-sm">Loading data…</span>
                  </span>
                </td>
              </tr>
            ) : view.length === 0 ? (
              <tr>
                <td className="td py-16 text-center" colSpan={columns.length}>
                  <div className="flex flex-col items-center gap-2">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800">
                      <Search className="h-5 w-5 text-slate-400" />
                    </div>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{q ? `No results for "${q}"` : empty}</p>
                  </div>
                </td>
              </tr>
            ) : (
              view.map((row, i) => (
                <tr
                  key={i}
                  className="group transition-colors hover:bg-brand-50/60 dark:hover:bg-brand-950/25"
                >
                  {columns.map((c) => (
                    <td key={c.key} className={`td ${c.align === 'right' ? 'text-right' : ''}`}>
                      {c.render ? c.render(row) : String(row[c.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {footer}
        </table>
      </div>

      {/* Nothing is hidden without saying so: the range, the total, and a way
          to reach the rest. */}
      {server && paging!.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-4 py-3 dark:border-slate-800 dark:bg-slate-800/30">
          <span className="num text-xs text-slate-500 dark:text-slate-400">
            Showing {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of{' '}
            <b className="text-slate-700 dark:text-slate-200">{paging!.total.toLocaleString()}</b>
          </span>
          <div className="flex items-center gap-1">
            <button
              className="btn btn-ghost !px-2 !py-1 text-xs disabled:opacity-40"
              disabled={paging!.page <= 1 || loading}
              onClick={() => paging!.onPage(paging!.page - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Previous
            </button>
            <span className="num px-2 text-xs text-slate-500 dark:text-slate-400">
              {paging!.page} / {lastPage.toLocaleString()}
            </span>
            <button
              className="btn btn-ghost !px-2 !py-1 text-xs disabled:opacity-40"
              disabled={paging!.page >= lastPage || loading}
              onClick={() => paging!.onPage(paging!.page + 1)}
            >
              Next <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
