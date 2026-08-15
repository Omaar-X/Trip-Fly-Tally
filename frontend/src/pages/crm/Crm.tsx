import { FormEvent, useEffect, useState } from 'react';
import { Plus, Users, Truck, Eye } from 'lucide-react';
import { api, apiErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { Badge, Column, DataTable, ErrorNote, Field, Modal, Money, PageHeader, statusTone } from '../../components/ui';
import { fmtDate } from '../../lib/format';
import { hasAnyRole, ROLE } from '../../lib/roles';

type Tab = 'customers' | 'suppliers';

interface Customer {
  id: number; name: string; email: string | null; phone: string | null;
  passport_no: string | null; credit_limit: string; outstanding: number;
}
interface Supplier { id: number; name: string; email: string | null; phone: string | null; payable: number }
interface Profile {
  customer: Customer & { address: string | null };
  payments: { payment_no: string; amount: string; method: string; payment_date: string; notes: string | null }[];
  bookings: { booking_no: string; booking_type: string; status: string; travel_date: string | null; sale_price: string; details: string | null }[];
  invoices: { invoice_no: string; invoice_date: string; total: string; paid_amount: string; status: string }[];
}

export default function Crm() {
  const { user } = useAuth();
  const role = user?.role ?? '';
  const [tab, setTab] = useState<Tab>('customers');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [profileId, setProfileId] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([api.get('/api/crm/customers'), api.get('/api/crm/suppliers')])
      .then(([c, s]) => { setCustomers(c.data.data); setSuppliers(s.data.data); })
      .finally(() => setLoading(false));
  }, [refresh]);

  const canCreateCustomer = hasAnyRole(role, [ROLE.ADMIN, ROLE.SALES, ROLE.ACCOUNTANT]);
  const canCreateSupplier = hasAnyRole(role, [ROLE.ADMIN, ROLE.ACCOUNTANT]);

  const customerCols: Column<Customer>[] = [
    { key: 'name', header: 'Customer', render: (c) => (
        <div><div className="font-medium">{c.name}</div><div className="text-xs text-slate-400">{c.email ?? '—'}</div></div>) },
    { key: 'phone', header: 'Phone', render: (c) => <span className="num">{c.phone ?? '—'}</span> },
    { key: 'passport_no', header: 'Passport', render: (c) => <span className="num text-xs">{c.passport_no ?? '—'}</span> },
    { key: 'credit_limit', header: 'Credit limit', align: 'right', render: (c) => <Money value={c.credit_limit} />, sortValue: (c) => Number(c.credit_limit) },
    { key: 'outstanding', header: 'Outstanding', align: 'right',
      render: (c) => <Money value={c.outstanding} className={Number(c.outstanding) > 0 ? 'font-semibold text-amber-600' : ''} />,
      sortValue: (c) => Number(c.outstanding) },
    { key: 'actions', header: '', align: 'right', render: (c) => (
        <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => setProfileId(c.id)}><Eye className="h-3.5 w-3.5" /> Profile</button>) }
  ];

  const supplierCols: Column<Supplier>[] = [
    { key: 'name', header: 'Supplier', render: (s) => (
        <div><div className="font-medium">{s.name}</div><div className="text-xs text-slate-400">{s.email ?? '—'}</div></div>) },
    { key: 'phone', header: 'Phone', render: (s) => <span className="num">{s.phone ?? '—'}</span> },
    { key: 'payable', header: 'Payable', align: 'right',
      render: (s) => <Money value={s.payable} className={Number(s.payable) > 0 ? 'font-semibold text-rose-600' : ''} />,
      sortValue: (s) => Number(s.payable) }
  ];

  return (
    <div>
      <PageHeader title="CRM" sub="Customers and suppliers — each carries its own sub-ledger in the books."
        actions={
          ((tab === 'customers' && canCreateCustomer) || (tab === 'suppliers' && canCreateSupplier)) ? (
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> New {tab === 'customers' ? 'customer' : 'supplier'}
            </button>
          ) : undefined
        } />

      <div className="mb-4 flex gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900 w-fit">
        {([
          { id: 'customers', label: 'Customers', icon: <Users className="h-4 w-4" /> },
          { id: 'suppliers', label: 'Suppliers', icon: <Truck className="h-4 w-4" /> }
        ] as { id: Tab; label: string; icon: JSX.Element }[]).map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition
              ${tab === t.id ? 'bg-brand-950 text-white shadow' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === 'customers'
        ? <DataTable columns={customerCols} rows={customers} loading={loading} empty="No customers yet." />
        : <DataTable columns={supplierCols} rows={suppliers} loading={loading} empty="No suppliers yet." />}

      <CreatePartyModal kind={tab} open={createOpen} onClose={() => setCreateOpen(false)}
        onDone={() => { setCreateOpen(false); setRefresh(r => r + 1); }} />
      <ProfileModal customerId={profileId} onClose={() => setProfileId(null)} />
    </div>
  );
}

function CreatePartyModal({ kind, open, onClose, onDone }:
  { kind: Tab; open: boolean; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '', address: '', passportNo: '', creditLimit: '0' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const base = { name: form.name, email: form.email || undefined, phone: form.phone || undefined, address: form.address || undefined };
      if (kind === 'customers') {
        await api.post('/api/crm/customers', { ...base, passportNo: form.passportNo || undefined, creditLimit: Number(form.creditLimit) || 0 });
      } else {
        await api.post('/api/crm/suppliers', base);
      }
      setForm({ name: '', email: '', phone: '', address: '', passportNo: '', creditLimit: '0' });
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={kind === 'customers' ? 'New Customer' : 'New Supplier'}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name"><input className="input" value={form.name} onChange={set('name')} required minLength={2} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email"><input className="input" type="email" value={form.email} onChange={set('email')} placeholder="Optional" /></Field>
          <Field label="Phone"><input className="input num" value={form.phone} onChange={set('phone')} placeholder="01XXXXXXXXX" /></Field>
        </div>
        <Field label="Address"><input className="input" value={form.address} onChange={set('address')} placeholder="Optional" /></Field>
        {kind === 'customers' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Passport no."><input className="input num" value={form.passportNo} onChange={set('passportNo')} placeholder="Optional" /></Field>
            <Field label="Credit limit (৳)"><input className="input num" type="number" min="0" step="0.01" value={form.creditLimit} onChange={set('creditLimit')} /></Field>
          </div>
        )}
        <p className="text-xs text-slate-400">A receivable/payable sub-ledger is opened automatically in the chart of accounts.</p>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ProfileModal({ customerId, onClose }: { customerId: number | null; onClose: () => void }) {
  const [data, setData] = useState<Profile | null>(null);

  useEffect(() => {
    if (!customerId) { setData(null); return; }
    api.get(`/api/crm/customers/${customerId}`).then((r) => setData(r.data.data));
  }, [customerId]);

  return (
    <Modal open={!!customerId} onClose={onClose} title={data?.customer?.name ?? 'Customer profile'} wide>
      {data && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><div className="label">Phone</div><div className="num">{data.customer.phone ?? '—'}</div></div>
            <div><div className="label">Email</div><div>{data.customer.email ?? '—'}</div></div>
            <div><div className="label">Passport</div><div className="num">{data.customer.passport_no ?? '—'}</div></div>
            <div><div className="label">Credit limit</div><Money value={data.customer.credit_limit} /></div>
          </div>

          <section>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Travel history</h3>
            {data.bookings.length === 0 ? <p className="text-sm text-slate-400">No bookings yet.</p> : (
              <table className="w-full text-sm">
                <thead><tr><th className="th text-left">Booking</th><th className="th text-left">Type</th><th className="th text-left">Travel date</th><th className="th text-right">Price</th><th className="th text-left">Status</th></tr></thead>
                <tbody>
                  {data.bookings.map((b) => (
                    <tr key={b.booking_no} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="td num">{b.booking_no}</td>
                      <td className="td">{b.booking_type}</td>
                      <td className="td num">{b.travel_date ? fmtDate(b.travel_date) : '—'}</td>
                      <td className="td num text-right"><Money value={b.sale_price} /></td>
                      <td className="td"><Badge tone={statusTone(b.status)}>{b.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Invoices</h3>
            {data.invoices.length === 0 ? <p className="text-sm text-slate-400">No invoices yet.</p> : (
              <table className="w-full text-sm">
                <thead><tr><th className="th text-left">Invoice</th><th className="th text-left">Date</th><th className="th text-right">Total</th><th className="th text-right">Paid</th><th className="th text-left">Status</th></tr></thead>
                <tbody>
                  {data.invoices.map((i) => (
                    <tr key={i.invoice_no} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="td num">{i.invoice_no}</td>
                      <td className="td num">{fmtDate(i.invoice_date)}</td>
                      <td className="td num text-right"><Money value={i.total} /></td>
                      <td className="td num text-right"><Money value={i.paid_amount} /></td>
                      <td className="td"><Badge tone={statusTone(i.status)}>{i.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Payments</h3>
            {data.payments.length === 0 ? <p className="text-sm text-slate-400">No payments recorded.</p> : (
              <table className="w-full text-sm">
                <thead><tr><th className="th text-left">Payment</th><th className="th text-left">Date</th><th className="th text-left">Method</th><th className="th text-right">Amount</th></tr></thead>
                <tbody>
                  {data.payments.map((p) => (
                    <tr key={p.payment_no} className="border-t border-slate-100 dark:border-slate-800">
                      <td className="td num">{p.payment_no}</td>
                      <td className="td num">{fmtDate(p.payment_date)}</td>
                      <td className="td"><Badge tone="blue">{p.method}</Badge></td>
                      <td className="td num text-right"><Money value={p.amount} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
