import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Plus, Eye, FileDown, Trash2 } from 'lucide-react';
import { api, apiErrorMessage, openPdf } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useServerList } from '../../lib/useServerList';
import { useCompanySettings } from '../../context/CompanySettingsContext';
import { Badge, Column, DataTable, ErrorNote, Field, Modal, Money, PageHeader, statusTone } from '../../components/ui';
import { bdt, fmtDate, today } from '../../lib/format';
import { hasAnyRole, ROLE } from '../../lib/roles';

interface InvoiceRow {
  id: number; invoice_no: string; invoice_date: string; due_date: string | null;
  subtotal: string; discount: string; total: string; paid_amount: string; due: string;
  status: string; customer_id: number; customer_name: string; booking_no: string | null;
}
interface InvoiceDetail extends InvoiceRow {
  vat_percent: string; vat_amount: string; customer_email: string | null;
  customer_phone: string | null; customer_address: string | null; voucher_no: string | null;
  items: { description: string; quantity: string; rate: string; amount: string }[];
  payments: { payment_no: string; method: string; amount: string; payment_date: string }[];
}
interface Lookup { id: number; name: string }
interface LedgerOpt { id: number; name: string; nature: string }

export default function Invoices() {
  const { user } = useAuth();
  const canCreate = hasAnyRole(user?.role, [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES]);
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const { rows, loading, paging, reload } = useServerList<InvoiceRow>(
    '/api/invoices', { status: status || undefined });

  const openDetail = (id: number) => api.get(`/api/invoices/${id}`).then((r) => setDetail(r.data.data));

  const columns: Column<InvoiceRow>[] = [
    { key: 'invoice_no', header: 'Invoice', render: (i) => (
        <div><span className="num font-medium">{i.invoice_no}</span>
          {i.booking_no && <div className="num text-[10px] text-slate-400">{i.booking_no}</div>}</div>) },
    { key: 'customer_name', header: 'Customer' },
    { key: 'invoice_date', header: 'Date', render: (i) => <span className="num">{fmtDate(i.invoice_date)}</span> },
    { key: 'due_date', header: 'Due', render: (i) => <span className="num">{i.due_date ? fmtDate(i.due_date) : '—'}</span> },
    { key: 'total', header: 'Total', align: 'right', render: (i) => <Money value={i.total} /> },
    { key: 'due', header: 'Balance due', align: 'right',
      render: (i) => <Money value={i.due} className={Number(i.due) > 0 ? 'font-semibold text-amber-600' : 'text-slate-400'} /> },
    { key: 'status', header: 'Status', render: (i) => <Badge tone={statusTone(i.status)}>{i.status}</Badge> },
    { key: 'actions', header: '', align: 'right', sortable: false, render: (i) => (
        <div className="flex justify-end gap-1">
          <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => openDetail(i.id)}><Eye className="h-3.5 w-3.5" /> View</button>
          <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => openPdf(`/api/invoices/${i.id}/pdf`)}><FileDown className="h-3.5 w-3.5" /> PDF</button>
        </div>) }
  ];

  return (
    <div>
      <PageHeader title="Invoices" sub="Tax invoices with BD VAT — print-ready PDF a click away."
        actions={canCreate ? <button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Manual invoice</button> : undefined} />

      <div className="mb-3 flex justify-end">
        <select className="input !w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="UNPAID">Unpaid</option><option value="PARTIAL">Partial</option>
          <option value="PAID">Paid</option><option value="VOID">Void</option>
        </select>
      </div>

      <DataTable columns={columns} rows={rows} loading={loading} paging={paging} empty="No invoices yet — confirm a booking or raise one manually." />

      <Modal open={!!detail} onClose={() => setDetail(null)} title={`Invoice ${detail?.invoice_no ?? ''}`} wide>
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="text-sm">
                <div className="font-semibold">{detail.customer_name}</div>
                <div className="text-slate-500">{detail.customer_phone ?? ''} {detail.customer_email ? `· ${detail.customer_email}` : ''}</div>
                <div className="text-slate-400">{detail.customer_address ?? ''}</div>
              </div>
              <div className="text-right text-sm">
                <Badge tone={statusTone(detail.status)}>{detail.status}</Badge>
                <div className="num mt-1 text-slate-500">Dated {fmtDate(detail.invoice_date)}</div>
                {detail.voucher_no && <div className="num text-xs text-slate-400">Voucher {detail.voucher_no}</div>}
              </div>
            </div>
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Description</th><th className="th text-right">Qty</th>
                <th className="th text-right">Rate</th><th className="th text-right">Amount</th>
              </tr></thead>
              <tbody>
                {detail.items.map((it, i) => (
                  <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="td">{it.description}</td>
                    <td className="td num text-right">{Number(it.quantity)}</td>
                    <td className="td num text-right">{bdt(Number(it.rate))}</td>
                    <td className="td num text-right">{bdt(Number(it.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="ml-auto w-64 space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="num">{bdt(Number(detail.subtotal))}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Discount</span><span className="num">− {bdt(Number(detail.discount))}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">VAT @ {Number(detail.vat_percent)}%</span><span className="num">+ {bdt(Number(detail.vat_amount))}</span></div>
              <div className="flex justify-between border-t border-slate-200 pt-1 font-bold dark:border-slate-700"><span>Total</span><span className="num">{bdt(Number(detail.total))}</span></div>
              <div className="flex justify-between text-emerald-600"><span>Paid</span><span className="num">{bdt(Number(detail.paid_amount))}</span></div>
              <div className="flex justify-between font-semibold text-amber-600"><span>Due</span><span className="num">{bdt(Number(detail.due))}</span></div>
            </div>
            {detail.payments.length > 0 && (
              <div>
                <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-slate-500">Payments received</h3>
                <ul className="space-y-1 text-sm">
                  {detail.payments.map((p) => (
                    <li key={p.payment_no} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5 dark:bg-slate-800/60">
                      <span className="num">{p.payment_no}</span>
                      <Badge tone="blue">{p.method}</Badge>
                      <span className="num">{fmtDate(p.payment_date)}</span>
                      <span className="num font-medium">{bdt(Number(p.amount))}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex justify-end">
              <button className="btn btn-primary" onClick={() => openPdf(`/api/invoices/${detail.id}/pdf`)}>
                <FileDown className="h-4 w-4" /> Download PDF
              </button>
            </div>
          </div>
        )}
      </Modal>

      <ManualInvoiceModal open={createOpen} onClose={() => setCreateOpen(false)}
        onDone={() => { setCreateOpen(false); reload(); }} />
    </div>
  );
}

interface LineDraft { description: string; quantity: string; rate: string }

function ManualInvoiceModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { company } = useCompanySettings();
  const [customers, setCustomers] = useState<Lookup[]>([]);
  const [incomeLedgers, setIncomeLedgers] = useState<LedgerOpt[]>([]);
  const [form, setForm] = useState({ customerId: '', invoiceDate: today(), dueDate: '', incomeLedgerId: '', discount: '0', vatPercent: '5' });
  const [lines, setLines] = useState<LineDraft[]>([{ description: '', quantity: '1', rate: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get('/api/crm/customers').then((r) => setCustomers(r.data.data));
    api.get('/api/ledgers').then((r) =>
      setIncomeLedgers((r.data.data as LedgerOpt[]).filter((l) => l.nature === 'INCOME')));
  }, [open]);

  /**
   * The preview must round exactly the way the API stores, or the total shown
   * before saving differs from the total on the printed invoice. Quantity
   * keeps 3 decimals (the column is DECIMAL(12,3)), rate keeps 2, and the line
   * amount comes from those ROUNDED figures — so quantity × rate always equals
   * the amount on the document.
   */
  const totals = useMemo(() => {
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    const subtotal = r2(lines.reduce(
      (s, l) => s + r2(r3(Number(l.quantity) || 0) * r2(Number(l.rate) || 0)), 0));
    const taxable = r2(Math.max(0, subtotal - (Number(form.discount) || 0)));
    const vat = r2(taxable * (Number(form.vatPercent) || 0) / 100);
    return { subtotal, vat, total: r2(taxable + vat) };
  }, [lines, form.discount, form.vatPercent]);

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setLines((p) => p.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/invoices', {
        customerId: Number(form.customerId),
        invoiceDate: form.invoiceDate,
        dueDate: form.dueDate || undefined,
        incomeLedgerId: Number(form.incomeLedgerId),
        discount: Number(form.discount) || 0,
        vatPercent: Number(form.vatPercent) || 0,
        items: lines.map((l) => ({ description: l.description, quantity: Number(l.quantity), rate: Number(l.rate) }))
      });
      setLines([{ description: '', quantity: '1', rate: '' }]);
      setForm({ customerId: '', invoiceDate: today(), dueDate: '', incomeLedgerId: '', discount: '0', vatPercent: '5' });
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Manual Invoice" wide>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer">
            <select className="input" value={form.customerId} onChange={(e) => setForm({ ...form, customerId: e.target.value })} required>
              <option value="">Select customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Income ledger" hint="Which sales account this revenue belongs to">
            <select className="input" value={form.incomeLedgerId} onChange={(e) => setForm({ ...form, incomeLedgerId: e.target.value })} required>
              <option value="">Select ledger…</option>
              {incomeLedgers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {/* Bounded by the books: nothing before they begin, nothing in the
              future, and a due date never earlier than the invoice itself. */}
          <Field label="Invoice date">
            <input type="date" className="input num" value={form.invoiceDate} required
              min={company?.books_begin_from ?? undefined} max={today()}
              onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} />
          </Field>
          <Field label="Due date">
            <input type="date" className="input num" value={form.dueDate} min={form.invoiceDate}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </Field>
          <Field label="Discount (৳)"><input className="input num" type="number" min="0" step="0.01" value={form.discount} onChange={(e) => setForm({ ...form, discount: e.target.value })} /></Field>
          <Field label="VAT %"><input className="input num" type="number" min="0" max="100" step="0.5" value={form.vatPercent} onChange={(e) => setForm({ ...form, vatPercent: e.target.value })} /></Field>
        </div>

        <div className="space-y-2">
          <span className="label">Line items</span>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 items-center gap-2">
              <input className="input col-span-6 !py-1.5" placeholder="Description" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} required />
              {/* 3 decimals, matching invoice_items.quantity DECIMAL(12,3) —
                  the precision the value is actually stored at. */}
              <input className="input num col-span-2 !py-1.5 text-right" type="number" min="0.001" step="0.001" placeholder="Qty" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} required />
              <input className="input num col-span-3 !py-1.5 text-right" type="number" min="0.01" step="0.01" placeholder="Rate" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value })} required />
              <button type="button" className="col-span-1 justify-self-center rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                onClick={() => setLines((p) => p.filter((_, idx) => idx !== i))} disabled={lines.length <= 1} aria-label="Remove line">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost text-xs" onClick={() => setLines((p) => [...p, { description: '', quantity: '1', rate: '' }])}>
            <Plus className="h-3.5 w-3.5" /> Add line
          </button>
        </div>

        <div className="ml-auto w-64 space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="num">{bdt(totals.subtotal)}</span></div>
          <div className="flex justify-between"><span className="text-slate-500">VAT</span><span className="num">+ {bdt(totals.vat)}</span></div>
          <div className="flex justify-between border-t border-slate-200 pt-1 font-bold dark:border-slate-700"><span>Total</span><span className="num">{bdt(totals.total)}</span></div>
        </div>

        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Posting…' : 'Raise invoice'}</button>
        </div>
      </form>
    </Modal>
  );
}
