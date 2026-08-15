import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Plus, BookOpenText, ScrollText, PenLine, Trash2, Eye, Scale, Undo2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { Badge, Column, DataTable, ErrorNote, Field, Modal, Money, PageHeader, statusTone } from '../../components/ui';
import ReverseModal from '../../components/ReverseModal';
import { bdt, fmtDate, today } from '../../lib/format';
import { hasAnyRole, ROLE } from '../../lib/roles';

type Tab = 'ledgers' | 'vouchers' | 'new';

interface Group { id: number; name: string; nature: string; parent_name: string | null }
interface Ledger {
  id: number; name: string; group_name: string; nature: string; is_system: number;
  opening_balance: string; opening_type: 'DR' | 'CR'; total_debit: string; total_credit: string;
  /** Signed toward the ledger's natural side, computed by the API. */
  closing_balance: string;
}
interface VoucherRow {
  id: number; voucher_no: string; voucher_type: string; voucher_date: string;
  narration: string | null; total_amount: string; created_by_name: string;
  status: 'ACTIVE' | 'REVERSED';
  /** Set when this voucher IS a reversal of another one. */
  reversal_of_voucher_id: number | null;
  reversed_by_voucher_id: number | null;
}
interface VoucherDetail extends VoucherRow {
  reference: string | null;
  reversal_of_voucher_no: string | null;
  reversed_by_voucher_no: string | null;
  reversal_reason: string | null;
  entries: { id: number; ledger_name: string; entry_type: 'DR' | 'CR'; amount: string; line_note: string | null }[];
}
interface StatementData {
  ledger: { id: number; name: string; nature: string; group: string };
  opening_balance: number; closing_balance: number;
  lines: { voucher_date: string; voucher_no: string; voucher_type: string; narration: string | null; entry_type: 'DR' | 'CR'; amount: string; running_balance: number }[];
}

const VOUCHER_TYPES = ['JOURNAL', 'PAYMENT', 'RECEIPT', 'SALES', 'PURCHASE', 'CONTRA', 'DEBIT_NOTE', 'CREDIT_NOTE'] as const;

/**
 * Net balance of a ledger, signed toward its natural side.
 *
 * The API now computes this, so we read its number rather than re-deriving the
 * sign rule here — two implementations of the same rule is one too many, and
 * the client's copy is the one nobody notices drifting.
 */
function ledgerBalance(l: Ledger): number {
  return Number(l.closing_balance ?? 0);
}

export default function Accounting() {
  const { user } = useAuth();
  // Voucher/ledger creation is Accountant's exclusive domain ("Accounting only") — Admin gets read/review access elsewhere on this page, not write.
  const canWrite = hasAnyRole(user?.role, [ROLE.ACCOUNTANT]);
  const [tab, setTab] = useState<Tab>('ledgers');
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  const reloadLedgers = () => {
    setLoading(true);
    Promise.all([api.get('/api/ledgers'), api.get('/api/ledger-groups')])
      .then(([l, g]) => { setLedgers(l.data.data); setGroups(g.data.data); })
      .finally(() => setLoading(false));
  };
  useEffect(reloadLedgers, []);

  const tabs: { id: Tab; label: string; icon: JSX.Element }[] = [
    { id: 'ledgers', label: 'Chart of Accounts', icon: <BookOpenText className="h-4 w-4" /> },
    { id: 'vouchers', label: 'Vouchers', icon: <ScrollText className="h-4 w-4" /> },
    ...(canWrite ? [{ id: 'new' as Tab, label: 'New Voucher', icon: <PenLine className="h-4 w-4" /> }] : [])
  ];

  return (
    <div>
      <PageHeader title="Accounting" sub="Double-entry ledger — every voucher must balance to the paisa." />
      <div className="mb-4 flex gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900 w-fit">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition
              ${tab === t.id ? 'bg-brand-950 text-white shadow' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === 'ledgers' && <LedgersTab ledgers={ledgers} groups={groups} loading={loading} canWrite={canWrite} onChanged={reloadLedgers} />}
      {tab === 'vouchers' && <VouchersTab canWrite={canWrite} />}
      {tab === 'new' && canWrite && <NewVoucher ledgers={ledgers} onPosted={() => { reloadLedgers(); setTab('vouchers'); }} />}
    </div>
  );
}

// ================================ Ledgers ====================================

function LedgersTab({ ledgers, groups, loading, canWrite, onChanged }:
  { ledgers: Ledger[]; groups: Group[]; loading: boolean; canWrite: boolean; onChanged: () => void }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [statementOf, setStatementOf] = useState<Ledger | null>(null);

  const columns: Column<Ledger>[] = [
    { key: 'name', header: 'Ledger', render: (l) => (
        <div>
          <div className="font-medium">{l.name}</div>
          <div className="text-xs text-slate-400">{l.group_name}</div>
        </div>) },
    { key: 'nature', header: 'Nature', render: (l) => <Badge tone={l.nature === 'INCOME' ? 'green' : l.nature === 'EXPENSE' ? 'amber' : l.nature === 'ASSET' ? 'teal' : 'blue'}>{l.nature}</Badge> },
    { key: 'total_debit', header: 'Debits', align: 'right', render: (l) => <Money value={l.total_debit} />, sortValue: (l) => Number(l.total_debit) },
    { key: 'total_credit', header: 'Credits', align: 'right', render: (l) => <Money value={l.total_credit} />, sortValue: (l) => Number(l.total_credit) },
    { key: 'balance', header: 'Balance', align: 'right', sortValue: ledgerBalance,
      render: (l) => { const b = ledgerBalance(l); return <Money value={b} className={b < 0 ? 'text-rose-600' : ''} />; } },
    { key: 'actions', header: '', align: 'right', render: (l) => (
        <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => setStatementOf(l)}>
          <Eye className="h-3.5 w-3.5" /> Statement
        </button>) }
  ];

  return (
    <>
      <div className="mb-3 flex justify-end">
        {canWrite && (
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" /> New Ledger
          </button>
        )}
      </div>
      <DataTable columns={columns} rows={ledgers} loading={loading} empty="No ledgers found — run the seed script." />
      <CreateLedgerModal open={createOpen} onClose={() => setCreateOpen(false)} groups={groups} onCreated={() => { setCreateOpen(false); onChanged(); }} />
      <StatementModal ledger={statementOf} onClose={() => setStatementOf(null)} />
    </>
  );
}

function CreateLedgerModal({ open, onClose, groups, onCreated }:
  { open: boolean; onClose: () => void; groups: Group[]; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');
  const [openingBalance, setOpeningBalance] = useState('0');
  const [openingType, setOpeningType] = useState<'DR' | 'CR'>('DR');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/ledgers', {
        name, groupId: Number(groupId),
        openingBalance: Number(openingBalance) || 0, openingType
      });
      setName(''); setOpeningBalance('0');
      onCreated();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="New Ledger">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Ledger name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required minLength={2} placeholder="e.g. Office Rent" />
        </Field>
        <Field label="Group">
          <select className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)} required>
            <option value="">Select group…</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name} · {g.nature}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Opening balance">
            <input className="input num" type="number" min="0" step="0.01" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} />
          </Field>
          <Field label="Opening side">
            <select className="input" value={openingType} onChange={(e) => setOpeningType(e.target.value as 'DR' | 'CR')}>
              <option value="DR">Debit</option><option value="CR">Credit</option>
            </select>
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Create ledger'}</button>
        </div>
      </form>
    </Modal>
  );
}

function StatementModal({ ledger, onClose }: { ledger: Ledger | null; onClose: () => void }) {
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(today());
  const [data, setData] = useState<StatementData | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ledger) { setData(null); return; }
    setBusy(true);
    api.get(`/api/ledgers/${ledger.id}/statement`, { params: { from, to } })
      .then((r) => setData(r.data.data))
      .finally(() => setBusy(false));
  }, [ledger, from, to]);

  return (
    <Modal open={!!ledger} onClose={onClose} title={`Statement — ${ledger?.name ?? ''}`} wide>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="From"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        {data && (
          <div className="ml-auto text-right text-sm">
            <div className="text-xs text-slate-400">Opening → Closing</div>
            <div className="num font-semibold">{bdt(data.opening_balance)} → {bdt(data.closing_balance)}</div>
          </div>
        )}
      </div>
      {busy ? <p className="py-8 text-center text-sm text-slate-400">Loading…</p> : data && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Date</th><th className="th text-left">Voucher</th>
              <th className="th text-left">Narration</th><th className="th text-right">Debit</th>
              <th className="th text-right">Credit</th><th className="th text-right">Balance</th>
            </tr></thead>
            <tbody>
              {data.lines.length === 0 && <tr><td colSpan={6} className="td py-8 text-center text-slate-400">No entries in this period.</td></tr>}
              {data.lines.map((l, i) => (
                <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="td num">{fmtDate(l.voucher_date)}</td>
                  <td className="td"><span className="num text-xs">{l.voucher_no}</span> <Badge tone={statusTone(l.entry_type)}>{l.entry_type}</Badge></td>
                  <td className="td max-w-[220px] truncate text-slate-500">{l.narration ?? '—'}</td>
                  <td className="td num text-right">{l.entry_type === 'DR' ? bdt(Number(l.amount)) : ''}</td>
                  <td className="td num text-right">{l.entry_type === 'CR' ? bdt(Number(l.amount)) : ''}</td>
                  <td className="td num text-right font-medium">{bdt(l.running_balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

// =============================== Vouchers ====================================

function VouchersTab({ canWrite }: { canWrite: boolean }) {
  const [rows, setRows] = useState<VoucherRow[]>([]);
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [detail, setDetail] = useState<VoucherDetail | null>(null);
  const [reverseOf, setReverseOf] = useState<VoucherRow | null>(null);

  useEffect(() => {
    setLoading(true);
    api.get('/api/vouchers', { params: type ? { type } : {} })
      .then((r) => setRows(r.data.data))
      .finally(() => setLoading(false));
  }, [type, refresh]);

  const openDetail = (id: number) =>
    api.get(`/api/vouchers/${id}`).then((r) => setDetail(r.data.data));

  const columns: Column<VoucherRow>[] = [
    { key: 'voucher_no', header: 'Voucher No.', render: (v) => (
        <span className="num font-medium">
          {v.voucher_no}
          {v.reversal_of_voucher_id && <span className="ml-1.5 text-[10px] uppercase text-slate-400">reversal</span>}
        </span>) },
    { key: 'voucher_date', header: 'Date', render: (v) => <span className="num">{fmtDate(v.voucher_date)}</span>, sortValue: (v) => v.voucher_date },
    { key: 'voucher_type', header: 'Type', render: (v) => <Badge tone="teal">{v.voucher_type}</Badge> },
    { key: 'status', header: 'Status', render: (v) => (
        <Badge tone={v.status === 'REVERSED' ? 'slate' : 'green'}>{v.status}</Badge>) },
    { key: 'narration', header: 'Narration', render: (v) => <span className="block max-w-[240px] truncate text-slate-500">{v.narration ?? '—'}</span> },
    { key: 'total_amount', header: 'Amount', align: 'right', render: (v) => <Money value={v.total_amount} />, sortValue: (v) => Number(v.total_amount) },
    { key: 'created_by_name', header: 'By' },
    { key: 'actions', header: '', align: 'right', render: (v) => (
        <div className="flex justify-end gap-1">
          <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => openDetail(v.id)}><Eye className="h-3.5 w-3.5" /> View</button>
          {/* A voucher is never edited or deleted; correcting it posts a
              mirror. Reversals themselves cannot be reversed again. */}
          {canWrite && v.status === 'ACTIVE' && !v.reversal_of_voucher_id && (
            <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => setReverseOf(v)}>
              <Undo2 className="h-3.5 w-3.5" /> Reverse
            </button>
          )}
        </div>) }
  ];

  return (
    <>
      <div className="mb-3 flex justify-end">
        <select className="input !w-auto" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {VOUCHER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <DataTable columns={columns} rows={rows} loading={loading} empty="No vouchers posted yet." />

      <ReverseModal
        open={!!reverseOf}
        onClose={() => setReverseOf(null)}
        onDone={() => { setReverseOf(null); setRefresh(r => r + 1); }}
        endpoint={`/api/vouchers/${reverseOf?.id}/reverse`}
        title="Reverse voucher"
        what={`voucher ${reverseOf?.voucher_no ?? ''}`}
        warning="Vouchers that belong to an invoice, payment, payroll run or stock movement are refused here — unwind those through their own screen so the document and the ledger stay in step."
      />

      <Modal open={!!detail} onClose={() => setDetail(null)} title={`Voucher ${detail?.voucher_no ?? ''}`} wide>
        {detail && (
          <div>
            <div className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div><div className="label">Date</div><div className="num">{fmtDate(detail.voucher_date)}</div></div>
              <div><div className="label">Type</div><Badge tone="teal">{detail.voucher_type}</Badge></div>
              <div><div className="label">Reference</div><div>{detail.reference ?? '—'}</div></div>
              <div><div className="label">Created by</div><div>{detail.created_by_name}</div></div>
            </div>
            {/* Both halves of a correction stay visible and point at each
                other — that pairing IS the audit trail. */}
            {detail.reversed_by_voucher_no && (
              <p className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800/60">
                Reversed by <span className="num font-medium">{detail.reversed_by_voucher_no}</span>
                {detail.reversal_reason && <> — {detail.reversal_reason}</>}
              </p>
            )}
            {detail.reversal_of_voucher_no && (
              <p className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-800/60">
                This voucher reverses <span className="num font-medium">{detail.reversal_of_voucher_no}</span>.
              </p>
            )}
            {detail.narration && <p className="mb-4 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">{detail.narration}</p>}
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Ledger</th><th className="th text-left">Note</th>
                <th className="th text-right">Debit</th><th className="th text-right">Credit</th>
              </tr></thead>
              <tbody>
                {detail.entries.map((e) => (
                  <tr key={e.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="td font-medium">{e.ledger_name}</td>
                    <td className="td text-slate-500">{e.line_note ?? '—'}</td>
                    <td className="td num text-right">{e.entry_type === 'DR' ? bdt(Number(e.amount)) : ''}</td>
                    <td className="td num text-right">{e.entry_type === 'CR' ? bdt(Number(e.amount)) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-semibold dark:border-slate-700">
                  <td className="td" colSpan={2}>Total</td>
                  <td className="td num text-right">{bdt(detail.entries.filter(e => e.entry_type === 'DR').reduce((s, e) => s + Number(e.amount), 0))}</td>
                  <td className="td num text-right">{bdt(detail.entries.filter(e => e.entry_type === 'CR').reduce((s, e) => s + Number(e.amount), 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Modal>
    </>
  );
}

// ============================== New Voucher ==================================

interface EntryDraft { ledgerId: string; type: 'DR' | 'CR'; amount: string; note: string }

/**
 * The signature screen: as you type lines, a "balance rail" fills from both
 * ends — debit from the left, credit from the right — and locks shut in
 * brand-teal only when Dr == Cr.
 */
function NewVoucher({ ledgers, onPosted }: { ledgers: Ledger[]; onPosted: () => void }) {
  const [type, setType] = useState<typeof VOUCHER_TYPES[number]>('JOURNAL');
  const [date, setDate] = useState(today());
  const [narration, setNarration] = useState('');
  const [reference, setReference] = useState('');
  const [entries, setEntries] = useState<EntryDraft[]>([
    { ledgerId: '', type: 'DR', amount: '', note: '' },
    { ledgerId: '', type: 'CR', amount: '', note: '' }
  ]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState<string | null>(null);

  const totals = useMemo(() => {
    const dr = entries.filter(e => e.type === 'DR').reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const cr = entries.filter(e => e.type === 'CR').reduce((s, e) => s + (Number(e.amount) || 0), 0);
    return { dr: Math.round(dr * 100) / 100, cr: Math.round(cr * 100) / 100 };
  }, [entries]);
  const balanced = totals.dr > 0 && Math.abs(totals.dr - totals.cr) < 0.005;
  const max = Math.max(totals.dr, totals.cr, 1);

  const setEntry = (i: number, patch: Partial<EntryDraft>) =>
    setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const addRow = (t: 'DR' | 'CR') => setEntries((p) => [...p, { ledgerId: '', type: t, amount: '', note: '' }]);
  const removeRow = (i: number) => setEntries((p) => p.filter((_, idx) => idx !== i));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setPosted(null);
    try {
      const payload = {
        type, date,
        narration: narration || undefined,
        reference: reference || undefined,
        entries: entries.map((en) => ({
          ledgerId: Number(en.ledgerId), type: en.type,
          amount: Number(en.amount), note: en.note || undefined
        }))
      };
      const r = await api.post('/api/vouchers', payload);
      setPosted(r.data.data.voucherNo ?? r.data.data.voucher_no ?? 'posted');
      setEntries([{ ledgerId: '', type: 'DR', amount: '', note: '' }, { ledgerId: '', type: 'CR', amount: '', note: '' }]);
      setNarration(''); setReference('');
      setTimeout(onPosted, 900);
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={submit} className="card p-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Field label="Voucher type">
          <select className="input" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            {VOUCHER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Date"><input type="date" className="input num" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        <Field label="Reference"><input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Bill / PNR / memo no." /></Field>
        <Field label="Narration"><input className="input" value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="What is this entry for?" /></Field>
      </div>

      {/* ---------------------------- entry lines --------------------------- */}
      <div className="mt-5 space-y-2">
        {entries.map((en, i) => (
          <div key={i} className="grid grid-cols-12 items-center gap-2">
            <select className={`input col-span-2 !py-1.5 text-xs font-bold ${en.type === 'DR' ? 'text-brand-700 dark:text-brand-300' : 'text-amber-700 dark:text-amber-400'}`}
              value={en.type} onChange={(e) => setEntry(i, { type: e.target.value as 'DR' | 'CR' })}>
              <option value="DR">DEBIT</option><option value="CR">CREDIT</option>
            </select>
            <select className="input col-span-4 !py-1.5" value={en.ledgerId} onChange={(e) => setEntry(i, { ledgerId: e.target.value })} required>
              <option value="">Select ledger…</option>
              {ledgers.map((l) => <option key={l.id} value={l.id}>{l.name} · {l.group_name}</option>)}
            </select>
            <input className="input num col-span-2 !py-1.5 text-right" type="number" min="0.01" step="0.01"
              placeholder="0.00" value={en.amount} onChange={(e) => setEntry(i, { amount: e.target.value })} required />
            <input className="input col-span-3 !py-1.5" placeholder="Line note (optional)" value={en.note} onChange={(e) => setEntry(i, { note: e.target.value })} />
            <button type="button" className="col-span-1 justify-self-center rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
              onClick={() => removeRow(i)} disabled={entries.length <= 2} aria-label="Remove line">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn btn-ghost text-xs" onClick={() => addRow('DR')}><Plus className="h-3.5 w-3.5" /> Debit line</button>
        <button type="button" className="btn btn-ghost text-xs" onClick={() => addRow('CR')}><Plus className="h-3.5 w-3.5" /> Credit line</button>
      </div>

      {/* ---------------------------- balance rail -------------------------- */}
      <div className="mt-6">
        <div className="mb-1.5 flex items-center justify-between text-xs font-semibold">
          <span className="num text-brand-700 dark:text-brand-300">Dr {bdt(totals.dr)}</span>
          <span className={`inline-flex items-center gap-1 ${balanced ? 'text-brand-600' : 'text-slate-400'}`}>
            <Scale className="h-3.5 w-3.5" />{balanced ? 'BALANCED' : `out by ${bdt(Math.abs(totals.dr - totals.cr))}`}
          </span>
          <span className="num text-amber-700 dark:text-amber-400">Cr {bdt(totals.cr)}</span>
        </div>
        <div className={`relative h-2.5 overflow-hidden rounded-full bg-slate-100 transition-colors dark:bg-slate-800 ${balanced ? 'ring-2 ring-brand-500/60' : ''}`}>
          <div className={`absolute left-0 top-0 h-full rounded-l-full transition-all duration-300 ${balanced ? 'bg-brand-600' : 'bg-brand-400/70'}`}
            style={{ width: `${Math.min(50, (totals.dr / max) * 50)}%` }} />
          <div className={`absolute right-0 top-0 h-full rounded-r-full transition-all duration-300 ${balanced ? 'bg-brand-600' : 'bg-amber-400/70'}`}
            style={{ width: `${Math.min(50, (totals.cr / max) * 50)}%` }} />
          {balanced && <div className="absolute left-1/2 top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded bg-white shadow" />}
        </div>
      </div>

      <div className="mt-5 space-y-3">
        <ErrorNote message={error} />
        {posted && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-300">Voucher {posted} posted ✓</div>}
        <div className="flex justify-end">
          <button className="btn btn-primary" disabled={!balanced || busy} title={balanced ? '' : 'Debits must equal credits'}>
            {busy ? 'Posting…' : 'Post voucher'}
          </button>
        </div>
      </div>
    </form>
  );
}
