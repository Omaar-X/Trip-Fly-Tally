import { FormEvent, useEffect, useState } from 'react';
import { Plus, CheckCircle2, XCircle, Plane, Hotel, Map } from 'lucide-react';
import { api, apiErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useCompanySettings } from '../../context/CompanySettingsContext';
import { useServerList } from '../../lib/useServerList';
import { Badge, Column, DataTable, ErrorNote, Field, Modal, Money, PageHeader, statusTone } from '../../components/ui';
import { bdt, fmtDate, today } from '../../lib/format';
import { hasAnyRole, ROLE } from '../../lib/roles';

interface Booking {
  id: number; booking_no: string; booking_type: 'FLIGHT' | 'HOTEL' | 'TOUR'; status: string;
  travel_date: string | null; return_date: string | null;
  cost_price: string; sale_price: string; margin: string;
  customer_id: number; customer_name: string;
  supplier_name: string | null; agent_name: string | null; invoice_no: string | null;
}
interface Lookup { id: number; name: string }
interface Employee { id: number; name: string; emp_code: string }

const TYPE_ICON: Record<string, JSX.Element> = {
  FLIGHT: <Plane className="h-3.5 w-3.5" />, HOTEL: <Hotel className="h-3.5 w-3.5" />, TOUR: <Map className="h-3.5 w-3.5" />
};

export default function Bookings() {
  const { user } = useAuth();
  const role = user?.role ?? '';
  const canCreate = hasAnyRole(role, [ROLE.ADMIN, ROLE.SALES]);
  const canAct = hasAnyRole(role, [ROLE.ADMIN, ROLE.SALES, ROLE.ACCOUNTANT]);

  const [status, setStatus] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmOf, setConfirmOf] = useState<Booking | null>(null);
  const [cancelOf, setCancelOf] = useState<Booking | null>(null);

  const [customers, setCustomers] = useState<Lookup[]>([]);
  const [suppliers, setSuppliers] = useState<Lookup[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);

  const { rows, loading, paging, reload } = useServerList<Booking>(
    '/api/bookings', { status: status || undefined });

  useEffect(() => {
    api.get('/api/crm/customers').then((r) => setCustomers(r.data.data));
    api.get('/api/crm/suppliers').then((r) => setSuppliers(r.data.data));
    // Employee lookup needs HR/ADMIN; fall back silently for SALES/ACCOUNTANT.
    api.get('/api/hr/employees').then((r) => setEmployees(r.data.data)).catch(() => setEmployees([]));
  }, []);

  const columns: Column<Booking>[] = [
    { key: 'booking_no', header: 'Booking', render: (b) => <span className="num font-medium">{b.booking_no}</span> },
    { key: 'booking_type', header: 'Type', render: (b) => (
        <Badge tone="teal"><span className="inline-flex items-center gap-1">{TYPE_ICON[b.booking_type]}{b.booking_type}</span></Badge>) },
    { key: 'customer_name', header: 'Customer', render: (b) => (
        <div><div className="font-medium">{b.customer_name}</div>
          <div className="text-xs text-slate-400">{b.agent_name ? `Agent: ${b.agent_name}` : 'No agent'}</div></div>) },
    { key: 'travel_date', header: 'Travel', render: (b) => <span className="num">{b.travel_date ? fmtDate(b.travel_date) : '—'}</span>, sortValue: (b) => b.travel_date ?? '' },
    { key: 'sale_price', header: 'Sale', align: 'right', render: (b) => <Money value={b.sale_price} />, sortValue: (b) => Number(b.sale_price) },
    { key: 'margin', header: 'Margin', align: 'right',
      render: (b) => <Money value={b.margin} className={Number(b.margin) >= 0 ? 'text-emerald-600' : 'text-rose-600'} />,
      sortValue: (b) => Number(b.margin) },
    { key: 'status', header: 'Status', render: (b) => (
        <div className="flex flex-col items-start gap-0.5">
          <Badge tone={statusTone(b.status)}>{b.status}</Badge>
          {b.invoice_no && <span className="num text-[10px] text-slate-400">{b.invoice_no}</span>}
        </div>) },
    { key: 'actions', header: '', align: 'right', render: (b) => canAct ? (
        <div className="flex justify-end gap-1">
          {b.status === 'PENDING' && (
            <button className="btn btn-ghost !px-2 !py-1 text-xs text-emerald-700 dark:text-emerald-400" onClick={() => setConfirmOf(b)}>
              <CheckCircle2 className="h-3.5 w-3.5" /> Confirm
            </button>)}
          {b.status !== 'CANCELLED' && (
            <button className="btn btn-ghost !px-2 !py-1 text-xs text-rose-600" onClick={() => setCancelOf(b)}>
              <XCircle className="h-3.5 w-3.5" /> Cancel
            </button>)}
        </div>) : null }
  ];

  return (
    <div>
      <PageHeader title="Travel Bookings" sub="Confirming a booking posts the sale and raises the invoice in one stroke."
        actions={canCreate ? <button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> New booking</button> : undefined} />

      <div className="mb-3 flex justify-end">
        <select className="input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
      </div>

      <DataTable columns={columns} rows={rows} loading={loading} paging={paging} empty="No bookings yet — create one to get started." />

      <CreateBookingModal open={createOpen} onClose={() => setCreateOpen(false)}
        customers={customers} suppliers={suppliers} employees={employees}
        onDone={() => { setCreateOpen(false); reload(); }} />
      <ConfirmModal booking={confirmOf} onClose={() => setConfirmOf(null)} onDone={() => { setConfirmOf(null); reload(); }} />
      <CancelModal booking={cancelOf} onClose={() => setCancelOf(null)} onDone={() => { setCancelOf(null); reload(); }} />
    </div>
  );
}

function CreateBookingModal({ open, onClose, customers, suppliers, employees, onDone }:
  { open: boolean; onClose: () => void; customers: Lookup[]; suppliers: Lookup[]; employees: Employee[]; onDone: () => void }) {
  const [form, setForm] = useState({
    customerId: '', bookingType: 'FLIGHT', travelDate: '', returnDate: '',
    costPrice: '', salePrice: '', supplierId: '', agentId: '', details: ''
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const margin = (Number(form.salePrice) || 0) - (Number(form.costPrice) || 0);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/bookings', {
        customerId: Number(form.customerId),
        bookingType: form.bookingType,
        travelDate: form.travelDate || undefined,
        returnDate: form.returnDate || undefined,
        costPrice: Number(form.costPrice) || 0,
        salePrice: Number(form.salePrice) || 0,
        supplierId: form.supplierId ? Number(form.supplierId) : undefined,
        agentId: form.agentId ? Number(form.agentId) : undefined,
        details: form.details ? { note: form.details } : undefined
      });
      setForm({ customerId: '', bookingType: 'FLIGHT', travelDate: '', returnDate: '', costPrice: '', salePrice: '', supplierId: '', agentId: '', details: '' });
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="New Booking" wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer">
            <select className="input" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })} required>
              <option value="">Select customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Service type">
            <select className="input" value={form.bookingType} onChange={(e) => setForm({ ...form, bookingType: e.target.value })}>
              <option value="FLIGHT">Flight ticket</option><option value="HOTEL">Hotel booking</option><option value="TOUR">Tour package</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Travel date"><input type="date" className="input num" value={form.travelDate} onChange={(e) => setForm({ ...form, travelDate: e.target.value })} /></Field>
          <Field label="Return date"><input type="date" className="input num" value={form.returnDate} onChange={(e) => setForm({ ...form, returnDate: e.target.value })} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cost price (৳)" hint="What the supplier charges us">
            <input className="input num" type="number" min="0" step="0.01" value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} required />
          </Field>
          <Field label="Sale price (৳)" hint={`Margin: ${bdt(margin)}`}>
            <input className="input num" type="number" min="0" step="0.01" value={form.salePrice} onChange={(e) => setForm({ ...form, salePrice: e.target.value })} required />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Supplier" hint="Required for cost posting on confirm">
            <select className="input" value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
              <option value="">None</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Sales agent" hint="Earns commission on margin">
            <select className="input" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
              <option value="">None</option>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.emp_code} — {e.name}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Details / PNR / room info"><input className="input" value={form.details} onChange={(e) => setForm({ ...form, details: e.target.value })} placeholder="e.g. DAC→DXB, BG147, PNR X9K2L" /></Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Create booking'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmModal({ booking, onClose, onDone }: { booking: Booking | null; onClose: () => void; onDone: () => void }) {
  const { company } = useCompanySettings();
  const [vatPercent, setVatPercent] = useState('5');
  const [discount, setDiscount] = useState('0');
  const [dueDate, setDueDate] = useState('');
  // The date revenue lands on. Confirmation used to stamp the server's clock,
  // so a June booking confirmed in August became August revenue.
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sale = Number(booking?.sale_price ?? 0);
  const taxable = Math.max(0, sale - (Number(discount) || 0));
  const vat = Math.round(taxable * (Number(vatPercent) || 0)) / 100;
  const total = Math.round((taxable + vat) * 100) / 100;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!booking) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/api/bookings/${booking.id}/confirm`, {
        vatPercent: Number(vatPercent) || 0,
        discount: Number(discount) || 0,
        dueDate: dueDate || undefined,
        invoiceDate,
      });
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={!!booking} onClose={onClose} title={`Confirm ${booking?.booking_no ?? ''}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Confirming posts the sales voucher, raises the tax invoice for <span className="font-semibold">{booking?.customer_name}</span>,
          and books the supplier cost if one is attached.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Invoice date" hint="The period this revenue belongs to">
            <input type="date" className="input num" required value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              min={company?.books_begin_from ?? undefined} max={today()} />
          </Field>
          <Field label="Due date">
            <input type="date" className="input num" value={dueDate}
              onChange={(e) => setDueDate(e.target.value)} min={invoiceDate} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="VAT %"><input className="input num" type="number" min="0" max="100" step="0.5" value={vatPercent} onChange={(e) => setVatPercent(e.target.value)} /></Field>
          <Field label="Discount (৳)"><input className="input num" type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} /></Field>
        </div>
        <div className="rounded-xl bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
          <div className="flex justify-between"><span>Sale price</span><span className="num">{bdt(sale)}</span></div>
          <div className="flex justify-between text-slate-500"><span>Discount</span><span className="num">− {bdt(Number(discount) || 0)}</span></div>
          <div className="flex justify-between text-slate-500"><span>VAT @ {vatPercent || 0}%</span><span className="num">+ {bdt(vat)}</span></div>
          <div className="mt-1 flex justify-between border-t border-slate-200 pt-1 font-bold dark:border-slate-700"><span>Invoice total</span><span className="num">{bdt(total)}</span></div>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Back</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Posting…' : 'Confirm & invoice'}</button>
        </div>
      </form>
    </Modal>
  );
}

function CancelModal({ booking, onClose, onDone }: { booking: Booking | null; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!booking) return;
    setBusy(true); setError(null);
    try {
      await api.post(`/api/bookings/${booking.id}/cancel`, { reason: reason || undefined });
      setReason('');
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={!!booking} onClose={onClose} title={`Cancel ${booking?.booking_no ?? ''}`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {booking?.status === 'CONFIRMED'
            ? 'This booking is invoiced — cancelling will post a credit note reversing the sale and void the invoice. Bookings with payments received cannot be cancelled.'
            : 'This pending booking will be marked cancelled. Nothing has been posted to the books yet.'}
        </p>
        <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer changed plans" /></Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Back</button>
          <button className="btn btn-danger" disabled={busy}>{busy ? 'Cancelling…' : 'Cancel booking'}</button>
        </div>
      </form>
    </Modal>
  );
}
