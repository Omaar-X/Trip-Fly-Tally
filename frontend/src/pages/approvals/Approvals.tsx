import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, Clock, AlertTriangle, CalendarClock } from 'lucide-react';
import { api, apiErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { ROLE, hasAnyRole } from '../../lib/roles';
import {
  Badge, Column, DataTable, ErrorNote, Field, Modal, PageHeader, Spinner, statusTone,
} from '../../components/ui';

/**
 * Edit/delete requests and backdated access, in one place.
 *
 * The two workflows sit side by side because the people who work them are the
 * same, but they are kept visibly distinct: a change request needs the CEO's
 * signature, while backdated access is final once the CEO *or* an authorised
 * Admin approves it. Showing them in one undifferentiated queue would blur the
 * one rule most likely to be got wrong.
 */

type Tab = 'changes' | 'bdr';

interface ChangeRequest {
  id: number; request_no: string; kind: 'EDIT' | 'DELETE';
  entity: string; entity_id: number; status: string; priority: string;
  reason: string; requested_by: number; requested_role: string;
  admin_recommendation: string | null; decision_note: string | null;
  version: number; created_at: string;
}

interface BdrRequest {
  id: number; request_no: string; module: string; status: string; priority: string;
  requested_from: string; requested_to: string;
  approved_from: string | null; approved_to: string | null;
  reason: string; requested_by: number; expires_at: string | null;
}

const priorityTone = (p: string) =>
  ({ URGENT: 'rose', HIGH: 'amber', NORMAL: 'slate', LOW: 'slate' }[p] ?? 'slate');

const shortDate = (v: string | null) => (v ? String(v).slice(0, 10) : '—');

export default function Approvals() {
  const { user } = useAuth();
  const [tab, setTab] = useState<Tab>('changes');
  const [changes, setChanges] = useState<ChangeRequest[]>([]);
  const [bdrs, setBdrs] = useState<BdrRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decide, setDecide] = useState<ChangeRequest | null>(null);
  const [approveBdr, setApproveBdr] = useState<BdrRequest | null>(null);

  const isCeo = user?.role === ROLE.CEO;
  const canReview = hasAnyRole(user?.role, [ROLE.ADMIN]);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.get('/api/approvals/change-requests'),
      api.get('/api/approvals/bdr'),
    ])
      .then(([c, b]) => { setChanges(c.data.data); setBdrs(b.data.data); })
      .catch((err) => setError(apiErrorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const pendingChanges = changes.filter((c) =>
    ['PENDING', 'NEEDS_CORRECTION', 'RESUBMITTED', 'ADMIN_REVIEWED'].includes(c.status)).length;
  const pendingBdr = bdrs.filter((b) => b.status === 'PENDING').length;
  const urgent = [...changes, ...bdrs].filter((r) =>
    r.priority === 'URGENT' && ['PENDING', 'RESUBMITTED', 'ADMIN_REVIEWED'].includes(r.status));

  const changeColumns: Column<ChangeRequest>[] = [
    { key: 'request_no', header: 'Request', render: (r) => (
      <div className="flex items-center gap-2">
        <span className="num font-semibold">{r.request_no}</span>
        {r.priority !== 'NORMAL' && <Badge tone={priorityTone(r.priority)}>{r.priority}</Badge>}
        {r.version > 1 && <Badge tone="slate">v{r.version}</Badge>}
      </div>
    ) },
    { key: 'kind', header: 'Kind', render: (r) => <Badge tone={r.kind === 'DELETE' ? 'rose' : 'blue'}>{r.kind}</Badge> },
    { key: 'entity', header: 'Transaction', render: (r) => `${r.entity} #${r.entity_id}` },
    { key: 'reason', header: 'Reason', render: (r) => <span className="line-clamp-2">{r.reason}</span> },
    { key: 'admin_recommendation', header: 'Admin', render: (r) =>
        r.admin_recommendation ? <Badge tone="violet">{r.admin_recommendation}</Badge>
                               : <span className="text-slate-400">—</span> },
    { key: 'status', header: 'Status', render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge> },
    { key: 'actions', header: '', render: (r) => (
      isCeo && ['PENDING', 'RESUBMITTED', 'ADMIN_REVIEWED', 'NEEDS_CORRECTION'].includes(r.status)
        ? <button className="btn-ghost !py-1 !px-2 text-xs" onClick={() => setDecide(r)}>Decide</button>
        : null
    ) },
  ];

  const bdrColumns: Column<BdrRequest>[] = [
    { key: 'request_no', header: 'Request', render: (r) => (
      <div className="flex items-center gap-2">
        <span className="num font-semibold">{r.request_no}</span>
        {r.priority !== 'NORMAL' && <Badge tone={priorityTone(r.priority)}>{r.priority}</Badge>}
      </div>
    ) },
    { key: 'module', header: 'Module', render: (r) => <Badge tone="teal">{r.module}</Badge> },
    { key: 'requested', header: 'Requested', render: (r) =>
        `${shortDate(r.requested_from)} → ${shortDate(r.requested_to)}` },
    { key: 'approved', header: 'Approved', render: (r) =>
        r.approved_from
          ? <span className="num">{shortDate(r.approved_from)} → {shortDate(r.approved_to)}</span>
          : <span className="text-slate-400">—</span> },
    { key: 'expires_at', header: 'Expires', render: (r) =>
        r.expires_at ? <span className="num text-xs">{new Date(r.expires_at).toLocaleString()}</span>
                     : <span className="text-slate-400">—</span> },
    { key: 'status', header: 'Status', render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge> },
    { key: 'actions', header: '', render: (r) => (
      (isCeo || canReview) && r.status === 'PENDING'
        ? <button className="btn-ghost !py-1 !px-2 text-xs" onClick={() => setApproveBdr(r)}>Review</button>
        : null
    ) },
  ];

  return (
    <>
      <PageHeader
        title="Approvals"
        icon={ShieldCheck}
        sub="Edit and delete requests need the CEO. Backdated access is final once the CEO or an authorised Admin approves."
      />

      {urgent.length > 0 && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 dark:border-rose-900 dark:bg-rose-950/40">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
          <div className="text-sm text-rose-800 dark:text-rose-200">
            <span className="font-semibold">{urgent.length} urgent request{urgent.length > 1 ? 's' : ''}</span>
            {' — '}{urgent.map((r) => ('request_no' in r ? r.request_no : '')).join(', ')}
          </div>
        </div>
      )}

      <ErrorNote message={error} />

      <div className="mb-4 flex gap-2">
        {([
          ['changes', 'Edit / Delete', pendingChanges, Clock],
          ['bdr', 'Backdated Access', pendingBdr, CalendarClock],
        ] as const).map(([id, label, count, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition ${
              tab === id ? 'bg-brand-600 text-white shadow-card'
                         : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'}`}
          >
            <Icon className="h-4 w-4" />
            {label}
            {count > 0 && (
              <span className={`num rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                tab === id ? 'bg-white/25' : 'bg-brand-600 text-white'}`}>{count}</span>
            )}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : tab === 'changes' ? (
        <DataTable
          rows={changes}
          columns={changeColumns}
          empty="No edit or delete requests."
        />
      ) : (
        <DataTable rows={bdrs} columns={bdrColumns} empty="No backdated access requests." />
      )}

      {decide && (
        <DecideModal request={decide} onClose={() => setDecide(null)} onDone={() => { setDecide(null); load(); }} />
      )}
      {approveBdr && (
        <BdrModal request={approveBdr} onClose={() => setApproveBdr(null)} onDone={() => { setApproveBdr(null); load(); }} />
      )}
    </>
  );
}

/**
 * The CEO's three verbs, and nothing else.
 *
 * There is deliberately no field here for editing the requester's proposed
 * values: a reviewer who can rewrite the proposal is making a change nobody
 * asked for and nobody signed.
 */
function DecideModal({ request, onClose, onDone }: {
  request: ChangeRequest; onClose: () => void; onDone: () => void;
}) {
  const [action, setAction] = useState<'APPROVE' | 'REJECT' | 'NEEDS_CORRECTION'>('APPROVE');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post(`/api/approvals/change-requests/${request.id}/decide`, { action, note: note || undefined });
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`${request.request_no} — ${request.kind.toLowerCase()}`}>
      <form onSubmit={submit} className="space-y-4">
        <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
          <div className="num font-semibold">{request.entity} #{request.entity_id}</div>
          <p className="mt-1 text-slate-600 dark:text-slate-300">{request.reason}</p>
        </div>

        <Field label="Decision">
          <select className="input" value={action} onChange={(e) => setAction(e.target.value as never)}>
            <option value="APPROVE">Approve — grants one use on this transaction</option>
            <option value="REJECT">Reject — the requester may correct and resubmit</option>
            <option value="NEEDS_CORRECTION">Needs correction — send it back with a comment</option>
          </select>
        </Field>

        <Field
          label="Comment"
          hint={action === 'NEEDS_CORRECTION'
            ? 'Required — say what needs correcting.'
            : 'Optional, and kept on the request’s history.'}
        >
          <textarea
            className="input min-h-[80px]" value={note} onChange={(e) => setNote(e.target.value)}
            required={action === 'NEEDS_CORRECTION'}
          />
        </Field>

        {action === 'APPROVE' && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            Approving grants the requester a single, one-time permission on this transaction.
            It expires the moment it is used.
          </p>
        )}

        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Submit decision'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Approve backdated access, optionally narrowing the window — never widening it. */
function BdrModal({ request, onClose, onDone }: {
  request: BdrRequest; onClose: () => void; onDone: () => void;
}) {
  const [from, setFrom] = useState(shortDate(request.requested_from));
  const [to, setTo] = useState(shortDate(request.requested_to));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (path: 'approve' | 'reject') => {
    setBusy(true); setError(null);
    try {
      await api.post(`/api/approvals/bdr/${request.id}/${path}`,
        path === 'approve' ? { from, to, note: note || undefined } : { note: note || undefined });
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title={`${request.request_no} — ${request.module}`}>
      <div className="space-y-4">
        <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
          <div>Requested <span className="num font-semibold">
            {shortDate(request.requested_from)} → {shortDate(request.requested_to)}</span></div>
          <p className="mt-1 text-slate-600 dark:text-slate-300">{request.reason}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Approve from">
            <input type="date" className="input num" value={from}
              min={shortDate(request.requested_from)} max={shortDate(request.requested_to)}
              onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="Approve to">
            <input type="date" className="input num" value={to}
              min={shortDate(request.requested_from)} max={shortDate(request.requested_to)}
              onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          You may narrow this window but not extend it past what was requested.
          Approved access lasts 24 hours.
        </p>

        <Field label="Note"><textarea className="input min-h-[60px]" value={note}
          onChange={(e) => setNote(e.target.value)} /></Field>

        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-ghost !text-rose-600" disabled={busy}
            onClick={() => act('reject')}>Reject</button>
          <button type="button" className="btn-primary" disabled={busy}
            onClick={() => act('approve')}>{busy ? 'Saving…' : 'Approve'}</button>
        </div>
      </div>
    </Modal>
  );
}
