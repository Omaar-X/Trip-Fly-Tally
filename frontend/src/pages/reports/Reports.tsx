import { useEffect, useMemo, useState } from 'react';
import { Scale, TrendingUp, Landmark, Wallet, Banknote, BookText, Users } from 'lucide-react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useCompanySettings } from '../../context/CompanySettingsContext';
import { Badge, Field, Spinner, PageHeader, statusTone } from '../../components/ui';
import { bdt, fmtDate, today } from '../../lib/format';
import { hasAnyRole, ROLE, RoleName } from '../../lib/roles';

type Tab = 'tb' | 'pl' | 'bs' | 'cash' | 'bank' | 'day' | 'outstanding';

// Report visibility mirrors the backend's per-report allow() list in reports.routes.ts.
const TABS: { id: Tab; label: string; icon: JSX.Element; roles: RoleName[] }[] = [
  { id: 'tb', label: 'Trial Balance', icon: <Scale className="h-4 w-4" />, roles: [ROLE.ACCOUNTANT] },
  { id: 'pl', label: 'Profit & Loss', icon: <TrendingUp className="h-4 w-4" />, roles: [ROLE.ACCOUNTANT] },
  { id: 'bs', label: 'Balance Sheet', icon: <Landmark className="h-4 w-4" />, roles: [ROLE.ACCOUNTANT] },
  { id: 'cash', label: 'Cash Book', icon: <Wallet className="h-4 w-4" />, roles: [ROLE.ACCOUNTANT, ROLE.ADMIN] },
  { id: 'bank', label: 'Bank Book', icon: <Banknote className="h-4 w-4" />, roles: [ROLE.ACCOUNTANT, ROLE.ADMIN] },
  { id: 'day', label: 'Day Book', icon: <BookText className="h-4 w-4" />, roles: [ROLE.ACCOUNTANT, ROLE.ADMIN] },
  { id: 'outstanding', label: 'Customer Outstanding', icon: <Users className="h-4 w-4" />, roles: [ROLE.ACCOUNTANT, ROLE.ADMIN, ROLE.SALES] }
];

export default function Reports() {
  const { user } = useAuth();
  const { company } = useCompanySettings();
  const visibleTabs = useMemo(() => TABS.filter((t) => hasAnyRole(user?.role, t.roles)), [user?.role]);
  const [tab, setTab] = useState<Tab>(() => visibleTabs[0]?.id ?? 'tb');
  // Reports open on the CURRENT FINANCIAL YEAR, not the calendar year. On a
  // July–June year a calendar default showed half of one year and half of the
  // next, which is not a period any statement should ever cover.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(today());
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Fill the range from the company's financial year the moment it arrives.
  useEffect(() => {
    if (company?.financial_year?.from && !from) setFrom(company.financial_year.from);
  }, [company?.financial_year?.from, from]);

  useEffect(() => {
    if (!visibleTabs.length) { setLoading(false); return; }
    const url =
      tab === 'tb' ? '/api/reports/trial-balance' :
      tab === 'pl' ? '/api/reports/profit-loss' :
      tab === 'bs' ? '/api/reports/balance-sheet' :
      tab === 'cash' ? '/api/reports/cash-book' :
      tab === 'bank' ? '/api/reports/bank-book' :
      tab === 'day' ? '/api/reports/day-book' : '/api/reports/customer-outstanding';
    // Empty values are omitted rather than sent blank: the API validates dates
    // strictly and treats a missing range as "the current financial year".
    const params = tab === 'bs' ? { asOn: to } : tab === 'outstanding' ? {}
      : { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    setLoading(true);
    api.get(url, { params }).then((r) => setData(r.data.data)).finally(() => setLoading(false));
  }, [tab, from, to, visibleTabs.length]);

  if (!visibleTabs.length) {
    return (
      <div>
        <PageHeader title="Reports" sub="Statutory and management reports, computed live from the voucher ledger." />
        <div className="card p-8 text-center text-sm text-slate-400">No reports are available for your role.</div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Reports" sub="Statutory and management reports, computed live from the voucher ledger." />

      <div className="mb-4 flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900 w-fit">
        {visibleTabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition
              ${tab === t.id ? 'bg-brand-950 text-white shadow' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab !== 'outstanding' && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          {tab !== 'bs' && <Field label="From"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>}
          <Field label={tab === 'bs' ? 'As on' : 'To'}><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      )}

      {loading ? <div className="flex h-48 items-center justify-center"><Spinner /></div> : data && (
        <div className="card overflow-x-auto p-5">
          {tab === 'tb' && <TrialBalance data={data} />}
          {tab === 'pl' && <ProfitLoss data={data} />}
          {tab === 'bs' && <BalanceSheet data={data} />}
          {(tab === 'cash' || tab === 'bank') && <BookTable data={data} />}
          {tab === 'day' && <DayBook rows={data} />}
          {tab === 'outstanding' && <Outstanding rows={data} />}
        </div>
      )}
    </div>
  );
}

const BalancedFlag = ({ ok }: { ok: boolean }) => (
  <Badge tone={ok ? 'green' : 'rose'}>{ok ? 'BALANCED ✓' : 'OUT OF BALANCE'}</Badge>
);

/**
 * Trial Balance in Tally's three-column shape: what each ledger opened the
 * period with, what moved during it, and what it closed at. Opening is the
 * balance carried forward from everything posted before `from` — not the
 * ledger's original opening, which is what it used to show.
 */
function TrialBalance({ data }: { data: any }) {
  const cell = (v: number) => (v ? bdt(v) : '');
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-bold">Trial Balance</h2>
        <BalancedFlag ok={data.balanced} />
      </div>
      {!!data.openingDifference && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
          <b>Difference in opening balances: {bdt(Math.abs(data.openingDifference))}</b> on the{' '}
          {data.openingDifference > 0 ? 'credit' : 'debit'} side. Every voucher balances, so the gap is
          entirely in the opening balances entered on the chart of accounts.
        </div>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="th text-left" rowSpan={2}>Ledger</th>
            <th className="th text-left" rowSpan={2}>Group</th>
            <th className="th text-center" colSpan={2}>Opening</th>
            <th className="th text-center" colSpan={2}>Period movement</th>
            <th className="th text-center" colSpan={2}>Closing</th>
          </tr>
          <tr className="text-[11px] uppercase tracking-wide text-slate-400">
            <th className="th text-right">Dr</th><th className="th text-right">Cr</th>
            <th className="th text-right">Dr</th><th className="th text-right">Cr</th>
            <th className="th text-right">Dr</th><th className="th text-right">Cr</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l: any) => (
            <tr key={l.ledger_id} className="border-t border-slate-100 dark:border-slate-800">
              <td className="td font-medium">{l.ledger}</td>
              <td className="td text-slate-500">{l.group}</td>
              <td className="td num text-right text-slate-500">{cell(l.opening_debit)}</td>
              <td className="td num text-right text-slate-500">{cell(l.opening_credit)}</td>
              <td className="td num text-right">{cell(l.debit)}</td>
              <td className="td num text-right">{cell(l.credit)}</td>
              <td className="td num text-right font-medium">{cell(l.closing_debit)}</td>
              <td className="td num text-right font-medium">{cell(l.closing_credit)}</td>
            </tr>
          ))}
          {data.lines.length === 0 && (
            <tr><td colSpan={8} className="td py-8 text-center text-slate-400">Nothing posted in this period.</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-300 font-bold dark:border-slate-700">
            <td className="td" colSpan={4}>Total</td>
            <td className="td num text-right">{bdt(data.totalDebit)}</td>
            <td className="td num text-right">{bdt(data.totalCredit)}</td>
            <td className="td num text-right">{bdt(data.closingDebit)}</td>
            <td className="td num text-right">{bdt(data.closingCredit)}</td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

function ProfitLoss({ data }: { data: any }) {
  const profit = data.netProfit >= 0;
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-bold">Profit &amp; Loss Statement</h2>
        <Badge tone={profit ? 'green' : 'rose'}>{profit ? 'NET PROFIT' : 'NET LOSS'} {bdt(Math.abs(data.netProfit))}</Badge>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-emerald-600">Income</h3>
          <table className="w-full text-sm">
            <tbody>
              {data.income.map((r: any, i: number) => (
                <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="td">{r.ledger}</td><td className="td num text-right">{bdt(r.amount)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-slate-300 font-bold dark:border-slate-700">
                <td className="td">Total income</td><td className="td num text-right">{bdt(data.totalIncome)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-amber-600">Expenses</h3>
          <table className="w-full text-sm">
            <tbody>
              {data.expenses.map((r: any, i: number) => (
                <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="td">{r.ledger}</td><td className="td num text-right">{bdt(r.amount)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-slate-300 font-bold dark:border-slate-700">
                <td className="td">Total expenses</td><td className="td num text-right">{bdt(data.totalExpense)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function BalanceSheet({ data }: { data: any }) {
  const Section = ({ title, rows, total }: { title: string; rows: any[]; total: number }) => (
    <div>
      <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">{title}</h3>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r: any, i: number) => (
            <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
              <td className="td">{r.ledger}<span className="ml-2 text-xs text-slate-400">{r.group}</span></td>
              <td className="td num text-right">{bdt(r.amount)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-slate-300 font-bold dark:border-slate-700">
            <td className="td">Total {title.toLowerCase()}</td><td className="td num text-right">{bdt(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-bold">Balance Sheet <span className="num text-sm font-normal text-slate-400">as on {fmtDate(data.asOn)}</span></h2>
        <BalancedFlag ok={data.balanced} />
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Section title="Assets" rows={data.assets} total={data.totalAssets} />
        <div className="space-y-6">
          <Section title="Liabilities" rows={data.liabilities} total={data.totalLiabilities} />
          <div>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Equity</h3>
            <table className="w-full text-sm">
              <tbody>
                {data.equity.map((r: any, i: number) => (
                  <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="td">{r.ledger}</td><td className="td num text-right">{bdt(r.amount)}</td>
                  </tr>
                ))}
                <tr className="border-t border-slate-100 dark:border-slate-800">
                  <td className="td">Retained earnings (P&amp;L)</td><td className="td num text-right">{bdt(data.retainedEarnings)}</td>
                </tr>
                {/* Tally's "Difference in Opening Balances". Shown rather than
                    absorbed: if the openings someone typed do not balance, the
                    gap has to be visible or the statement is a lie. */}
                {!!data.openingDifference && (
                  <tr className="border-t border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
                    <td className="td text-amber-800 dark:text-amber-300">Difference in opening balances</td>
                    <td className="td num text-right text-amber-800 dark:text-amber-300">{bdt(data.openingDifference)}</td>
                  </tr>
                )}
                <tr className="border-t-2 border-slate-300 font-bold dark:border-slate-700">
                  <td className="td">Liabilities + Equity</td><td className="td num text-right">{bdt(data.totalLiabilitiesAndEquity)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * Cash / Bank Book as a real register: opening balance, every movement with a
 * running balance, then the closing balance. It used to be a bare list of
 * hits, which told you what moved but never what you had.
 */
function BookTable({ data }: { data: any }) {
  const lines: any[] = data?.lines ?? [];
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold">{data.book === 'cash' ? 'Cash Book' : 'Bank Book'}</h2>
        <div className="flex gap-4 text-sm">
          <span className="text-slate-500">Opening <b className="num text-slate-700 dark:text-slate-200">{bdt(data.opening)}</b></span>
          <span className="text-slate-500">Closing <b className="num text-slate-700 dark:text-slate-200">{bdt(data.closing)}</b></span>
        </div>
      </div>
      {data.ledgers?.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {data.ledgers.map((l: any) => <Badge key={l.id} tone="teal">{l.name}</Badge>)}
        </div>
      )}
      <table className="w-full text-sm">
        <thead><tr>
          <th className="th text-left">Date</th><th className="th text-left">Voucher</th>
          <th className="th text-left">Ledger</th><th className="th text-left">Narration</th>
          <th className="th text-right">In (Dr)</th><th className="th text-right">Out (Cr)</th>
          <th className="th text-right">Balance</th>
        </tr></thead>
        <tbody>
          <tr className="border-t border-slate-100 text-slate-500 dark:border-slate-800">
            <td className="td" colSpan={6}>Opening balance</td>
            <td className="td num text-right font-medium">{bdt(data.opening)}</td>
          </tr>
          {lines.length === 0 && <tr><td colSpan={7} className="td py-8 text-center text-slate-400">No movement in this period.</td></tr>}
          {lines.map((r: any, i: number) => (
            <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
              <td className="td num">{fmtDate(r.voucher_date)}</td>
              <td className="td"><span className="num text-xs">{r.voucher_no}</span> <Badge tone="teal">{r.voucher_type}</Badge></td>
              <td className="td">{r.ledger}</td>
              <td className="td max-w-[220px] truncate text-slate-500">{r.narration ?? '—'}</td>
              <td className="td num text-right">{r.inflow ? bdt(r.inflow) : ''}</td>
              <td className="td num text-right">{r.outflow ? bdt(r.outflow) : ''}</td>
              <td className="td num text-right">{bdt(r.running_balance)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-slate-300 font-bold dark:border-slate-700">
            <td className="td" colSpan={6}>Closing balance</td>
            <td className="td num text-right">{bdt(data.closing)}</td>
          </tr>
        </tfoot>
      </table>
    </>
  );
}

function DayBook({ rows }: { rows: any[] }) {
  return (
    <table className="w-full text-sm">
      <thead><tr>
        <th className="th text-left">Date</th><th className="th text-left">Voucher</th><th className="th text-left">Type</th>
        <th className="th text-left">Narration</th><th className="th text-right">Amount</th><th className="th text-left">By</th>
      </tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={6} className="td py-8 text-center text-slate-400">No vouchers in this period.</td></tr>}
        {rows.map((r: any) => (
          <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
            <td className="td num">{fmtDate(r.voucher_date)}</td>
            <td className="td num">{r.voucher_no}</td>
            <td className="td"><Badge tone="teal">{r.voucher_type}</Badge></td>
            <td className="td max-w-[260px] truncate text-slate-500">{r.narration ?? '—'}</td>
            <td className="td num text-right">{bdt(Number(r.total_amount))}</td>
            <td className="td">{r.created_by}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Outstanding({ rows }: { rows: any[] }) {
  return (
    <table className="w-full text-sm">
      <thead><tr>
        <th className="th text-left">Customer</th><th className="th text-left">Phone</th>
        <th className="th text-right">Credit limit</th><th className="th text-right">Outstanding</th><th className="th text-left">Status</th>
      </tr></thead>
      <tbody>
        {rows.length === 0 && <tr><td colSpan={5} className="td py-8 text-center text-slate-400">No customers with balances.</td></tr>}
        {rows.map((r: any) => {
          const over = Number(r.credit_limit) > 0 && Number(r.outstanding) > Number(r.credit_limit);
          return (
            <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
              <td className="td font-medium">{r.name}</td>
              <td className="td num">{r.phone ?? '—'}</td>
              <td className="td num text-right">{bdt(Number(r.credit_limit))}</td>
              <td className="td num text-right font-semibold">{bdt(Number(r.outstanding))}</td>
              <td className="td"><Badge tone={over ? 'rose' : statusTone(Number(r.outstanding) > 0 ? 'PENDING' : 'PAID')}>{over ? 'OVER LIMIT' : Number(r.outstanding) > 0 ? 'DUE' : 'CLEAR'}</Badge></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
