import { useEffect, useMemo, useState } from 'react';
import { api, apiErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';

type Item = Record<string, string | number | null> & { id: number; issue_type: string; status: string };
type Summary = { issue_type: string; status: string; rows_n: number; amount: number };
type Period = { id: number; source_period: string; data_completeness: string; accounting_integrity: string; reconciliation_status: string; ceo_approval_status: string; material_review_count: number };

const money = (value: unknown) => `BDT ${Number(value || 0).toLocaleString('en-BD', { minimumFractionDigits: 2 })}`;

export default function HistoricalReview() {
  const { user } = useAuth();
  const [items, setItems] = useState<Item[]>([]);
  const [summary, setSummary] = useState<Summary[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [issueType, setIssueType] = useState('');
  const [period, setPeriod] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Item | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [approvalPeriod, setApprovalPeriod] = useState<Period | null>(null);
  const [approvalReason, setApprovalReason] = useState('');
  const [approvalComment, setApprovalComment] = useState('');
  const [approving, setApproving] = useState(false);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const params = { status: 'OPEN', issueType: issueType || undefined, period: period || undefined, search: search || undefined, limit: 250 };
      const [review, readiness] = await Promise.all([
        api.get('/api/migration/reports/material-review', { params }),
        api.get('/api/migration/reports/period-readiness'),
      ]);
      setItems(review.data.data.items); setSummary(review.data.data.summary); setPeriods(readiness.data.data);
    } catch (e) { setError(apiErrorMessage(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [issueType, period]);
  const categories = useMemo(() => [...new Set(summary.map(x => x.issue_type))], [summary]);
  const totals = summary.filter(x => x.status === 'OPEN').reduce((a, x) => ({ n: a.n + Number(x.rows_n), amount: a.amount + Number(x.amount) }), { n: 0, amount: 0 });

  const openDetail = async (item: Item) => {
    setSelected(item); setDetail(null);
    try { const r = await api.get(`/api/migration/review-items/${item.id}/detail`); setDetail(r.data.data); }
    catch (e) { setError(apiErrorMessage(e)); }
  };

  const approvePeriod = async () => {
    if (!approvalPeriod || !approvalReason.trim() || !approvalComment.trim()) return;
    setApproving(true); setError('');
    try {
      await api.post(`/api/migration/batches/${approvalPeriod.id}/finalize`, {
        reason: approvalReason.trim(), comment: approvalComment.trim(),
      });
      setApprovalPeriod(null); setApprovalReason(''); setApprovalComment('');
      await load();
    } catch (e) { setError(apiErrorMessage(e)); }
    finally { setApproving(false); }
  };

  return <div className="space-y-5 p-1">
    <div><h1 className="text-2xl font-bold text-slate-900 dark:text-white">Material Historical Review Workbench</h1>
      <p className="mt-1 text-sm text-slate-500">Evidence-first queue. Open items remain unresolved until a controlled decision is recorded.</p></div>
    <div className="grid gap-3 sm:grid-cols-3">
      <Card label="Open material items" value={totals.n.toLocaleString()} />
      <Card label="Open financial impact" value={money(totals.amount)} />
      <Card label="Periods awaiting CEO review" value={`${periods.filter(p => p.ceo_approval_status !== 'APPROVED').length} / ${periods.length}`} />
    </div>
    <div className="rounded-xl border bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="grid gap-3 md:grid-cols-4">
        <select className="rounded-lg border p-2 dark:bg-slate-800" value={issueType} onChange={e => setIssueType(e.target.value)}><option value="">All categories</option>{categories.map(x => <option key={x}>{x}</option>)}</select>
        <select className="rounded-lg border p-2 dark:bg-slate-800" value={period} onChange={e => setPeriod(e.target.value)}><option value="">All periods</option>{periods.map(x => <option key={x.id}>{x.source_period}</option>)}</select>
        <input className="rounded-lg border p-2 dark:bg-slate-800" placeholder="Ticket, PNR, party, evidence" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && void load()} />
        <button className="rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white" onClick={() => void load()}>Search</button>
      </div>
    </div>
    {error && <div className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    <div className="overflow-x-auto rounded-xl border bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <table className="min-w-full text-sm"><thead className="bg-slate-50 text-left dark:bg-slate-800"><tr>{['Period','Category','Source','Party / narration','Impact','Status',''].map(x => <th className="p-3" key={x}>{x}</th>)}</tr></thead>
        <tbody>{loading ? <tr><td className="p-6" colSpan={7}>Loading…</td></tr> : items.map(x => <tr className="border-t dark:border-slate-700" key={x.id}><td className="p-3">{x.source_period}</td><td className="p-3 font-medium">{x.issue_type}</td><td className="p-3">{x.ticket || x.pnr || x.source_ref}</td><td className="max-w-xs truncate p-3">{x.original_party_name || x.issue}</td><td className="p-3 text-right tabular-nums">{money(x.impact_amount)}</td><td className="p-3"><span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-800">{x.status}</span></td><td className="p-3"><button className="text-brand-700 underline" onClick={() => void openDetail(x)}>Evidence</button></td></tr>)}</tbody>
      </table>
    </div>
    <div className="rounded-xl border bg-white p-4 dark:border-slate-700 dark:bg-slate-900"><h2 className="font-bold">Month-by-month CEO review readiness</h2>
      <div className="mt-3 grid gap-2 md:grid-cols-2">{periods.map(p => <div className="flex items-center justify-between gap-3 rounded-lg border p-3 dark:border-slate-700" key={p.id}><div><div className="font-semibold">{p.source_period}</div><div className="text-xs text-slate-500">Integrity {p.accounting_integrity} · Reconciliation {p.reconciliation_status} · {p.material_review_count} material open</div></div><div className="flex flex-col items-end gap-2"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${p.data_completeness === 'INCOMPLETE' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>{p.data_completeness}</span>{user?.role === 'CEO' && p.ceo_approval_status !== 'APPROVED' && <button className="rounded bg-brand-600 px-2 py-1 text-xs font-semibold text-white" onClick={() => setApprovalPeriod(p)}>Review acceptance</button>}</div></div>)}</div>
    </div>
    {approvalPeriod && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setApprovalPeriod(null)}><section className="w-full max-w-2xl rounded-xl bg-white p-6 shadow-xl dark:bg-slate-900" onClick={e => e.stopPropagation()}><h2 className="text-xl font-bold">CEO period acceptance · {approvalPeriod.source_period}</h2><p className="mt-2 text-sm text-amber-700">This records an individual audited acceptance. It does not make an incomplete period complete.</p><label className="mt-5 block text-sm font-semibold">Mandatory reason<input className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-800" value={approvalReason} onChange={e => setApprovalReason(e.target.value)} /></label><label className="mt-4 block text-sm font-semibold">Mandatory permanent audit comment<textarea className="mt-1 min-h-32 w-full rounded-lg border p-2 dark:bg-slate-800" value={approvalComment} onChange={e => setApprovalComment(e.target.value)} /></label><div className="mt-5 flex justify-end gap-2"><button className="rounded border px-4 py-2" onClick={() => setApprovalPeriod(null)}>Cancel</button><button className="rounded bg-brand-600 px-4 py-2 font-semibold text-white disabled:opacity-50" disabled={approving || !approvalReason.trim() || !approvalComment.trim()} onClick={() => void approvePeriod()}>{approving ? 'Recording…' : 'Accept with Historical Data Limitation'}</button></div></section></div>}
    {selected && <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setSelected(null)}><aside className="h-full w-full max-w-xl overflow-y-auto bg-white p-6 shadow-xl dark:bg-slate-900" onClick={e => e.stopPropagation()}><button className="float-right text-xl" onClick={() => setSelected(null)}>×</button><h2 className="text-xl font-bold">Review #{selected.id}</h2>{!detail ? <p className="mt-6">Loading evidence…</p> : <><dl className="mt-5 grid grid-cols-2 gap-3 text-sm">{Object.entries(detail.item).filter(([,v]) => v != null && v !== '').map(([k,v]) => <div key={k} className="rounded border p-2 dark:border-slate-700"><dt className="text-xs uppercase text-slate-500">{k.replaceAll('_',' ')}</dt><dd className="mt-1 break-words">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></div>)}</dl><h3 className="mt-5 font-bold">Audit history</h3>{detail.actions.length ? detail.actions.map((a:any) => <div className="mt-2 rounded border p-3 text-sm dark:border-slate-700" key={a.id}>{a.action_code} · {a.actor_name}<div className="text-slate-500">{a.evidence}</div></div>) : <p className="mt-2 text-sm text-slate-500">No decision recorded.</p>}</>}</aside></div>}
  </div>;
}

function Card({ label, value }: { label: string; value: string }) { return <div className="rounded-xl border bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900"><div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-2 text-xl font-bold">{value}</div></div>; }
