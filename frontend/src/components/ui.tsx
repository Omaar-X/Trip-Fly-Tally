import { ComponentType, ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
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

// ───────────────────────────── SearchSelect ─────────────────────────────────

export interface SearchOption {
  value: string | number;
  label: string;
  /** Secondary text — a ledger's group, an item's stock, an invoice's due. */
  hint?: string;
}

/**
 * A picker you type into instead of scroll through.
 *
 * A native <select> is fine for eight voucher types and unusable for three
 * hundred ledgers, which is what a book with real history carries. Anyone who
 * has worked in Tally expects to type "cit" and land on City Bank rather than
 * hunt an alphabetical list with the mouse — so the keyboard drives everything
 * here: type to narrow, arrows to move, Enter to take, Escape to back out.
 *
 * The list is capped while rendering. Past the cap the answer is not a longer
 * list, it is another letter typed.
 */
const MAX_VISIBLE = 50;

export function SearchSelect({
  value, onChange, options, placeholder = 'Search…', disabled, required, className = '', ariaLabel,
  emptyLabel, loadOptions, selectedOption, debounceMs = 300, pageSize = 25, footer,
}: {
  value: string | number | '';
  onChange: (value: string) => void;
  /** The whole list, for sets small enough to hold — ledgers, items, banks. */
  options?: SearchOption[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  ariaLabel?: string;
  /**
   * Wording for "nothing chosen" on an optional field ("None", "On account").
   * Without it the control has no way back to empty once a row is taken, which
   * is exactly the trap a <select> with a blank first option avoids.
   */
  emptyLabel?: string;
  /**
   * Server-side mode. Given instead of `options` when the set is too large to
   * ship to the browser — customers and suppliers, once the history is in.
   * Called on open and then debounced per keystroke.
   */
  loadOptions?: (query: string, signal: AbortSignal) => Promise<SearchOption[]>;
  /**
   * The chosen row, in server mode. The results list holds only what the last
   * query returned, so without this the control would forget the label of a
   * selection the moment the user types something that does not match it.
   */
  selectedOption?: SearchOption | null;
  debounceMs?: number;
  /**
   * How many rows `loadOptions` asks the server for. Used only to tell a full
   * page apart from an exhausted one, so the "keep typing" hint is honest.
   */
  pageSize?: number;
  /** Rendered under the results — this is where "+ Add New" lives. */
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<SearchOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();

  const server = Boolean(loadOptions);

  const all = useMemo<SearchOption[]>(() => {
    const base = server ? remote : (options ?? []);
    return emptyLabel ? [{ value: '', label: emptyLabel }, ...base] : base;
  }, [server, remote, options, emptyLabel]);

  const selected = useMemo(() => {
    if (String(value) === '') return emptyLabel ? { value: '', label: emptyLabel } : null;
    // In server mode the parent is the only reliable holder of the label.
    if (server) return selectedOption ?? all.find((o) => String(o.value) === String(value)) ?? null;
    return all.find((o) => String(o.value) === String(value)) ?? null;
  }, [server, selectedOption, all, value, emptyLabel]);

  /**
   * Debounced fetch. Every run aborts the one before it, so a fast typist
   * cannot have an early, broader response land after a later, narrower one
   * and repopulate the list with the wrong rows.
   */
  useEffect(() => {
    if (!loadOptions || !open) return;
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      loadOptions(query.trim(), controller.signal)
        .then((rows) => { setRemote(rows); setFailed(false); })
        .catch((err) => { if (!controller.signal.aborted) { setRemote([]); setFailed(true); } })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query.trim() ? debounceMs : 0);   // opening the box should not feel delayed
    return () => { clearTimeout(timer); controller.abort(); };
  }, [loadOptions, open, query, debounceMs]);

  const matches = useMemo(() => {
    // The server already filtered; filtering again would hide rows it matched
    // on a field the browser cannot see, such as a phone number.
    if (server) return all;
    const q = query.trim().toLowerCase();
    if (!q) return all;
    // Hint is searched too: "bank" should find a ledger by its group even when
    // the ledger's own name never says so.
    return all.filter((o) =>
      o.label.toLowerCase().includes(q) || (o.hint?.toLowerCase().includes(q) ?? false));
  }, [server, all, query]);

  const shown = matches.slice(0, MAX_VISIBLE);

  // Keep the highlight on a row that still exists after each keystroke.
  useEffect(() => { setActive(0); }, [query]);

  // Follow the highlight when it moves past the visible edge of the list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLLIElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const close = () => { setOpen(false); setQuery(''); };

  const pick = (option: SearchOption) => {
    onChange(String(option.value));
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive((i) => {
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        return Math.max(0, Math.min(shown.length - 1, next));
      });
      return;
    }
    if (e.key === 'Enter') {
      // Only swallow Enter when it has a row to take — otherwise the form's
      // own submit must still work from inside this field.
      if (open && shown[active]) { e.preventDefault(); pick(shown[active]); }
      return;
    }
    if (e.key === 'Escape') { if (open) { e.stopPropagation(); close(); } return; }
    if (e.key === 'Tab') close();
  };

  return (
    <div
      ref={boxRef}
      className={`relative ${className}`}
      // Closing on focus leaving the whole control — rather than on the
      // input's own blur — is what lets a click land on an option first.
      onBlur={(e) => { if (!boxRef.current?.contains(e.relatedTarget as Node | null)) close(); }}
    >
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        className="input !py-1.5 pr-8"
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        // Closed, the field reads as the chosen row; open, it is the search box.
        value={open ? query : (selected?.label ?? '')}
        onChange={(e) => { setQuery(e.target.value); if (!open) setOpen(true); }}
        onFocus={(e) => { setOpen(true); setQuery(''); e.target.select(); }}
        onKeyDown={onKeyDown}
      />
      {/* Clearing is its own button rather than only the emptyLabel row: on a
          required field there is no empty row to pick, and a user who chose
          the wrong customer still needs a way back without reloading. */}
      {String(value) !== '' && !disabled ? (
        <button
          type="button"
          aria-label={ariaLabel ? `Clear ${ariaLabel}` : 'Clear selection'}
          onMouseDown={(e) => { e.preventDefault(); onChange(''); close(); }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-700 dark:hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400">
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                   : open ? <Search className="h-3.5 w-3.5" />
                          : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      )}

      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-800"
        >
          {shown.map((o, i) => (
            <li
              key={o.value}
              data-idx={i}
              role="option"
              aria-selected={String(o.value) === String(value)}
              // mousedown, not click: the press must not blur the input and
              // close the list out from under the pointer.
              onMouseDown={(e) => { e.preventDefault(); pick(o); }}
              onMouseEnter={() => setActive(i)}
              className={`flex cursor-pointer items-baseline justify-between gap-2 px-3 py-1.5 text-sm ${
                i === active ? 'bg-brand-50 text-brand-900 dark:bg-brand-950/60 dark:text-brand-100'
                             : 'text-slate-700 dark:text-slate-200'}`}
            >
              <span className="truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{o.hint}</span>}
            </li>
          ))}

          {/* Three different empty states, because they call for three
              different actions: wait, retry, or type something else. */}
          {!shown.length && loading && (
            <li className="flex items-center gap-2 px-3 py-2 text-sm text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
            </li>
          )}
          {!shown.length && !loading && failed && (
            <li className="px-3 py-2 text-sm text-rose-500">Search failed — check the connection.</li>
          )}
          {!shown.length && !loading && !failed && (
            <li className="px-3 py-2 text-sm text-slate-400">
              {query.trim() ? `No match for “${query}”` : 'Nothing to choose from yet'}
            </li>
          )}

          {matches.length > shown.length && (
            <li className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-400 dark:border-slate-700">
              {matches.length - shown.length} more — keep typing to narrow
            </li>
          )}
          {/* Server mode cannot say how many more there are, only that the page
              was full — which is the same signal to the person typing. */}
          {server && !loading && remote.length >= pageSize && (
            <li className="border-t border-slate-100 px-3 py-1.5 text-xs text-slate-400 dark:border-slate-700">
              More matches — keep typing to narrow
            </li>
          )}

          {footer && (
            <li className="border-t border-slate-100 dark:border-slate-700">{footer}</li>
          )}
        </ul>
      )}
    </div>
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
