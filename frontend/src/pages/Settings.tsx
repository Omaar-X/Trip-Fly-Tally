import { FormEvent, useEffect, useState } from 'react';
import { Plus, Moon, Sun, ShieldCheck, Building2, Lock } from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useCompanySettings } from '../context/CompanySettingsContext';
import { Badge, Column, DataTable, ErrorNote, Field, Modal, PageHeader } from '../components/ui';
import { fmtDate } from '../lib/format';
import CompanyForm from '../components/company/CompanyForm';
import { ROLES, ROLE, ROLE_LABELS, ROLE_TONE, ROLE_DESCRIPTIONS, hasAnyRole, RoleName } from '../lib/roles';

interface UserRow { id: number; name: string; email: string; role: string; is_active: number; approval_status: string; created_at: string }

export default function Settings() {
  const { user } = useAuth();
  const { dark, toggle } = useTheme();
  const isCeo = user?.role === ROLE.CEO;
  const canSeeUsers = hasAnyRole(user?.role, [ROLE.ADMIN]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(canSeeUsers);
  const [refresh, setRefresh] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!canSeeUsers) return;
    setLoading(true);
    api.get('/api/auth/users').then((r) => setUsers(r.data.data)).finally(() => setLoading(false));
  }, [refresh, canSeeUsers]);

  const columns: Column<UserRow>[] = [
    { key: 'name', header: 'User', render: (u) => (
        <div><div className="font-medium">{u.name}</div><div className="text-xs text-slate-400">{u.email}</div></div>) },
    { key: 'role', header: 'Role', render: (u) => <Badge tone={ROLE_TONE[u.role as RoleName] ?? 'slate'}>{u.role}</Badge> },
    { key: 'is_active', header: 'Status', render: (u) => <Badge tone={u.approval_status === 'APPROVED' ? 'green' : u.approval_status === 'PENDING' ? 'amber' : 'slate'}>{u.approval_status ?? (u.is_active ? 'APPROVED' : 'INACTIVE')}</Badge> },
    ...(isCeo ? [{ key: 'approval_status', header: 'Approval', render: (u: UserRow) => u.approval_status === 'PENDING' ? <div className="flex gap-2"><button className="btn btn-primary !px-2 !py-1 text-xs" onClick={() => api.put(`/api/auth/users/${u.id}/approval`, { status: 'APPROVED' }).then(() => setRefresh(r => r + 1))}>Approve</button><button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => api.put(`/api/auth/users/${u.id}/approval`, { status: 'REJECTED' }).then(() => setRefresh(r => r + 1))}>Reject</button></div> : <span className="text-xs text-slate-400">—</span> }] as Column<UserRow>[] : []),
    { key: 'created_at', header: 'Added', render: (u) => <span className="num">{fmtDate(u.created_at)}</span>, sortValue: (u) => u.created_at }
  ];

  return (
    <div>
      <PageHeader title="Settings" sub="Company profile, users, roles and appearance." />

      {isCeo && (
        <>
          <div className="card mb-4 p-5">
            <h2 className="mb-3 flex items-center gap-2 font-bold"><Building2 className="h-4 w-4 text-brand-600" /> Company</h2>
            <CompanyForm variant="settings" />
          </div>
          <PeriodLockCard />
        </>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4">
          <div className="card p-5">
            <h2 className="mb-3 font-bold">Appearance</h2>
            <button className="btn btn-ghost w-full justify-between" onClick={toggle}>
              <span className="inline-flex items-center gap-2">{dark ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />} {dark ? 'Dark mode' : 'Light mode'}</span>
              <span className="text-xs text-slate-400">Tap to switch</span>
            </button>
          </div>

          <div className="card p-5">
            <h2 className="mb-3 flex items-center gap-2 font-bold"><ShieldCheck className="h-4 w-4 text-brand-600" /> Role permissions</h2>
            <ul className="space-y-3 text-sm">
              {ROLES.map((role) => (
                <li key={role}>
                  <Badge tone={ROLE_TONE[role]}>{ROLE_LABELS[role]}</Badge>
                  <p className="mt-1 text-slate-500 dark:text-slate-400">{ROLE_DESCRIPTIONS[role]}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="xl:col-span-2">
          {canSeeUsers ? (
            <>
              <div className="mb-3 flex justify-end">
                {isCeo && <button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New user</button>}
              </div>
              <DataTable columns={columns} rows={users} loading={loading} empty="No users found." />
            </>
          ) : (
            <div className="card p-8 text-center text-sm text-slate-400">
              User management is available to the CEO and Admins.
            </div>
          )}
        </div>
      </div>

      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} onDone={() => { setCreateOpen(false); setRefresh(r => r + 1); }} />
    </div>
  );
}

/**
 * Closing the books. Everything on or before the lock date becomes unpostable,
 * so a filed year stays filed: corrections after it have to be posted in the
 * open period as reversals rather than by quietly editing history.
 *
 * Reopening is allowed — a lock is a control, not a one-way door — but it is
 * CEO-only and written to the audit log either way.
 */
const yesterday = (): string => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

function PeriodLockCard() {
  const { company, refresh } = useCompanySettings();
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const lockedUpto = company?.books_locked_upto ?? null;

  useEffect(() => { setDate(lockedUpto ?? ''); }, [lockedUpto]);

  const save = async (value: string | null) => {
    setBusy(true); setError(null); setDone(null);
    try {
      await api.put('/api/company-settings/period-lock', { booksLockedUpto: value });
      await refresh();
      setDone(value ? `Books locked up to ${fmtDate(value)}.` : 'Books reopened.');
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="card mb-4 p-5">
      <h2 className="mb-1 flex items-center gap-2 font-bold">
        <Lock className="h-4 w-4 text-brand-600" /> Period lock
      </h2>
      <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
        {lockedUpto
          ? <>The books are closed up to <b className="num">{fmtDate(lockedUpto)}</b>. Nothing can be posted on or before that date.</>
          : <>The books are fully open. Lock a closed year so its reports stop moving.</>}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        {/* Yesterday at the latest: the lock is inclusive and the future is
            already closed, so locking up to today would leave no postable day
            and freeze the books solid until midnight. */}
        <Field label="Lock everything up to and including" hint="Must be a date that has passed">
          <input type="date" className="input num" value={date} max={yesterday()}
            onChange={(e) => setDate(e.target.value)} />
        </Field>
        <button className="btn btn-primary" disabled={busy || !date} onClick={() => save(date)}>
          {busy ? 'Saving…' : 'Lock period'}
        </button>
        {lockedUpto && (
          <button className="btn btn-ghost" disabled={busy} onClick={() => save(null)}>Reopen books</button>
        )}
      </div>
      {done && <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">{done}</p>}
      <ErrorNote message={error} />
    </div>
  );
}

function CreateUserModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', password: '', role: ROLE.SALES as RoleName });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/auth/register', form);
      setForm({ name: '', email: '', password: '', role: ROLE.SALES });
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="New User">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Full name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} /></Field>
        <Field label="Email"><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Password" hint="At least 6 characters">
            <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={6} />
          </Field>
          <Field label="Role">
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as RoleName })}>
              {ROLES.filter((r) => r !== ROLE.CEO).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button>
        </div>
      </form>
    </Modal>
  );
}
