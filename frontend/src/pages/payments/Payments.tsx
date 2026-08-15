import { FormEvent, useEffect, useState } from 'react';
import { Plus, ArrowDownLeft, ArrowUpRight, Undo2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useServerList } from '../../lib/useServerList';
import { Badge, Column, DataTable, ErrorNote, Field, Modal, Money, PageHeader, statusTone } from '../../components/ui';
import ReverseModal from '../../components/ReverseModal';
import { bdt, fmtDate, today } from '../../lib/format';
import { hasAnyRole, ROLE } from '../../lib/roles';

interface PaymentRow {
  id: number; payment_no: string; direction: 'IN' | 'OUT'; method: string;
  amount: string; payment_date: string; notes: string | null;
  customer_name: string | null; supplier_name: string | null; invoice_no?: string | null;
  voucher_no?: string | null;
  /** REVERSED once its voucher has been mirrored — the payment is spent. */
  voucher_status?: 'ACTIVE' | 'REVERSED' | null;
}
interface Lookup { id: number; name: string }
interface OpenInvoice { id: number; invoice_no: string; customer_id: number; customer_name: string; due: string; status: string }

const METHODS = ['CASH', 'BANK', 'BKASH', 'NAGAD', 'CARD'] as const;

export default function Payments() {
  const { user } = useAuth();
  const canRecord = hasAnyRole(user?.role, [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES]);
  // Undoing money that was never really received or paid is an accounting
  // correction, not a collection — the API restricts it to Accounts too.
  const canReverse = hasAnyRole(user?.role, [ROLE.ACCOUNTANT]);
  const [direction, setDirection] = useState('');
  const [recordOpen, setRecordOpen] = useState(false);
  const [reverseOf, setReverseOf] = useState<PaymentRow | null>(null);

  const { rows, loading, paging, reload } = useServerList<PaymentRow>(
    '/api/payments', { direction: direction || undefined });

  const columns: Column<PaymentRow>[] = [
    { key: 'payment_no', header: 'Payment', render: (p) => <span className="num font-medium">{p.payment_no}</span> },
    { key: 'direction', header: 'Direction', render: (p) => (
        <Badge tone={statusTone(p.direction)}>
          <span className="inline-flex items-center gap-1">
            {p.direction === 'IN' ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}{p.direction}
          </span>
        </Badge>) },
    { key: 'party', header: 'Party', render: (p) => p.customer_name ?? p.supplier_name ?? '—' },
    { key: 'method', header: 'Method', render: (p) => <Badge tone="blue">{p.method}</Badge> },
    { key: 'payment_date', header: 'Date', render: (p) => <span className="num">{fmtDate(p.payment_date)}</span>, sortValue: (p) => p.payment_date },
    { key: 'amount', header: 'Amount', align: 'right',
      render: (p) => <Money value={p.amount} className={p.direction === 'IN' ? 'text-emerald-600' : 'text-rose-600'} />,
      sortValue: (p) => Number(p.amount) },
    { key: 'notes', header: 'Notes', render: (p) => <span className="block max-w-[200px] truncate text-slate-500">{p.notes ?? '—'}</span> },
    { key: 'actions', header: '', align: 'right', render: (p) => (
        p.voucher_status === 'REVERSED'
          ? <Badge tone="slate">REVERSED</Badge>
          : canReverse
            ? <button className="btn btn-ghost !py-1 !px-2 text-xs" onClick={() => setReverseOf(p)}>
                <Undo2 className="h-3.5 w-3.5" /> Reverse
              </button>
            : null) }
  ];

  return (
    <div>
      <PageHeader title="Payments" sub="Money in from customers, money out to suppliers — each posts its own voucher."
        actions={canRecord ? <button className="btn btn-primary" onClick={() => setRecordOpen(true)}><Plus className="h-4 w-4" /> Record payment</button> : undefined} />

      <div className="mb-3 flex justify-end">
        <select className="input !w-auto" value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="">All directions</option>
          <option value="IN">IN — received</option>
          <option value="OUT">OUT — paid</option>
        </select>
      </div>

      <DataTable columns={columns} rows={rows} loading={loading} paging={paging} empty="No payments recorded yet." />

      <RecordModal open={recordOpen} onClose={() => setRecordOpen(false)} onDone={() => { setRecordOpen(false); reload(); }} />

      <ReverseModal
        open={!!reverseOf}
        onClose={() => setReverseOf(null)}
        onDone={() => { setReverseOf(null); reload(); }}
        endpoint={`/api/payments/${reverseOf?.id}/reverse`}
        title="Reverse payment"
        what={`payment ${reverseOf?.payment_no ?? ''}`}
        warning={reverseOf?.invoice_no
          ? `Invoice ${reverseOf.invoice_no} will have this ${bdt(Number(reverseOf.amount))} taken back off what it shows as collected.`
          : undefined}
      />
    </div>
  );
}

function RecordModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { user } = useAuth();
  // Sales' "Collection" scope covers receiving money from customers only — the backend rejects OUT for Sales too.
  const directions = user?.role === ROLE.SALES ? (['IN'] as const) : (['IN', 'OUT'] as const);
  const [customers, setCustomers] = useState<Lookup[]>([]);
  const [suppliers, setSuppliers] = useState<Lookup[]>([]);
  const [invoices, setInvoices] = useState<OpenInvoice[]>([]);
  const [form, setForm] = useState({
    direction: 'IN' as 'IN' | 'OUT', customerId: '', supplierId: '',
    invoiceId: '', method: 'CASH', amount: '', paymentDate: today(), notes: ''
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get('/api/crm/customers').then((r) => setCustomers(r.data.data));
    api.get('/api/crm/suppliers').then((r) => setSuppliers(r.data.data));
    // The open-invoice picker asks the API for exactly what it needs. Fetching
    // the invoice list and filtering it here would now see only the first
    // page, so a customer's unpaid invoice could simply be missing from the
    // dropdown with nothing to indicate why.
    Promise.all([
      api.get('/api/invoices', { params: { status: 'UNPAID', pageSize: 200 } }),
      api.get('/api/invoices', { params: { status: 'PARTIAL', pageSize: 200 } }),
    ]).then(([unpaid, partial]) =>
      setInvoices([...unpaid.data.data, ...partial.data.data] as OpenInvoice[]));
  }, [open]);

  const openForCustomer = invoices.filter((i) => String(i.customer_id) === form.customerId);
  const selectedInvoice = invoices.find((i) => String(i.id) === form.invoiceId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/payments', {
        direction: form.direction,
        customerId: form.direction === 'IN' ? Number(form.customerId) : undefined,
        supplierId: form.direction === 'OUT' ? Number(form.supplierId) : undefined,
        invoiceId: form.direction === 'IN' && form.invoiceId ? Number(form.invoiceId) : undefined,
        method: form.method,
        amount: Number(form.amount),
        paymentDate: form.paymentDate,
        notes: form.notes || undefined
      });
      setForm({ direction: 'IN', customerId: '', supplierId: '', invoiceId: '', method: 'CASH', amount: '', paymentDate: today(), notes: '' });
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Record Payment">
      <form onSubmit={submit} className="space-y-4">
        <div className={`grid gap-2 ${directions.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {directions.map((d) => (
            <button key={d} type="button"
              onClick={() => setForm({ ...form, direction: d, customerId: '', supplierId: '', invoiceId: '' })}
              className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-semibold transition
                ${form.direction === d
                  ? d === 'IN' ? 'border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
                               : 'border-rose-500 bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300'
                  : 'border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'}`}>
              {d === 'IN' ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
              {d === 'IN' ? 'Receive from customer' : 'Pay supplier'}
            </button>
          ))}
        </div>

        {form.direction === 'IN' ? (
          <>
            <Field label="Customer">
              <select className="input" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value, invoiceId: '' })} required>
                <option value="">Select customer…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Settle against invoice" hint="Optional — updates the invoice's paid status">
              <select className="input" value={form.invoiceId} onChange={(e) => setForm({ ...form, invoiceId: e.target.value })}>
                <option value="">On account (no specific invoice)</option>
                {openForCustomer.map((i) => <option key={i.id} value={i.id}>{i.invoice_no} — due {bdt(Number(i.due))}</option>)}
              </select>
            </Field>
            {selectedInvoice && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                Balance due on {selectedInvoice.invoice_no}: <span className="num font-semibold">{bdt(Number(selectedInvoice.due))}</span> — overpayment is rejected.
              </p>
            )}
          </>
        ) : (
          <Field label="Supplier">
            <select className="input" value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })} required>
              <option value="">Select supplier…</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        )}

        <div className="grid grid-cols-3 gap-3">
          <Field label="Method">
            <select className="input" value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Amount (৳)"><input className="input num" type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required /></Field>
          <Field label="Date"><input type="date" className="input num" value={form.paymentDate} onChange={(e) => setForm({ ...form, paymentDate: e.target.value })} required /></Field>
        </div>
        <Field label="Notes"><input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional" /></Field>

        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Posting…' : 'Record payment'}</button>
        </div>
      </form>
    </Modal>
  );
}
