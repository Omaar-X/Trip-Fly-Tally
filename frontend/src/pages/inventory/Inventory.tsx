import { FormEvent, useEffect, useState } from 'react';
import { Plus, Boxes, ArrowLeftRight, ClipboardList, Undo2 } from 'lucide-react';
import { api, apiErrorMessage } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useCompanySettings } from '../../context/CompanySettingsContext';
import { useServerList } from '../../lib/useServerList';
import { Badge, Column, DataTable, ErrorNote, Field, Modal, Money, PageHeader, statusTone } from '../../components/ui';
import ReverseModal from '../../components/ReverseModal';
import { fmtDate, today } from '../../lib/format';
import { hasAnyRole, ROLE } from '../../lib/roles';

type Tab = 'items' | 'stock' | 'movements';

interface Item {
  id: number; sku: string; name: string; category: string | null; unit: string;
  purchase_price: string; sale_price: string; reorder_level: string; stock_qty: string;
}
interface Warehouse { id: number; name: string }
interface Lookup { id: number; name: string }
interface StockRow {
  item_id: number; sku: string; name: string; unit: string; quantity: number;
  fifo_value: number; weighted_avg_value: number; avg_rate: number; low_stock: boolean;
}
interface Movement {
  id: number; sku: string; item_name: string; warehouse_name: string;
  entry_type: 'IN' | 'OUT'; quantity: string; rate: string; value_amount: string;
  entry_date: string; note: string | null;
  supplier_name: string | null; voucher_no: string | null;
  voucher_status: 'ACTIVE' | 'REVERSED' | null;
}

export default function Inventory() {
  const { user } = useAuth();
  const { company } = useCompanySettings();
  const canWrite = hasAnyRole(user?.role, [ROLE.ADMIN, ROLE.ACCOUNTANT, ROLE.SALES]);
  const canCreateItem = hasAnyRole(user?.role, [ROLE.ADMIN, ROLE.ACCOUNTANT]);
  // A movement now posts to the ledger, so undoing one is an accounting act.
  const canReverse = hasAnyRole(user?.role, [ROLE.ADMIN, ROLE.ACCOUNTANT]);
  const [tab, setTab] = useState<Tab>('items');
  const [items, setItems] = useState<Item[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [suppliers, setSuppliers] = useState<Lookup[]>([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [itemModal, setItemModal] = useState(false);
  const [moveModal, setMoveModal] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get('/api/inventory/items'),
      api.get('/api/inventory/warehouses'),
      api.get('/api/crm/suppliers'),
    ])
      .then(([i, w, s]) => { setItems(i.data.data); setWarehouses(w.data.data); setSuppliers(s.data.data); })
      .finally(() => setLoading(false));
  }, [refresh]);

  const tabs: { id: Tab; label: string; icon: JSX.Element }[] = [
    { id: 'items', label: 'Items', icon: <Boxes className="h-4 w-4" /> },
    { id: 'stock', label: 'Stock Valuation', icon: <ClipboardList className="h-4 w-4" /> },
    { id: 'movements', label: 'Movements', icon: <ArrowLeftRight className="h-4 w-4" /> }
  ];

  const itemColumns: Column<Item>[] = [
    { key: 'sku', header: 'SKU', render: (i) => <span className="num text-xs font-semibold">{i.sku}</span> },
    { key: 'name', header: 'Item', render: (i) => (
        <div><div className="font-medium">{i.name}</div><div className="text-xs text-slate-400">{i.category ?? '—'}</div></div>) },
    { key: 'stock_qty', header: 'In stock', align: 'right',
      render: (i) => <span className={`num font-semibold ${Number(i.stock_qty) <= Number(i.reorder_level) ? 'text-rose-600' : ''}`}>{Number(i.stock_qty)} {i.unit}</span>,
      sortValue: (i) => Number(i.stock_qty) },
    { key: 'purchase_price', header: 'Purchase', align: 'right', render: (i) => <Money value={i.purchase_price} />, sortValue: (i) => Number(i.purchase_price) },
    { key: 'sale_price', header: 'Sale', align: 'right', render: (i) => <Money value={i.sale_price} />, sortValue: (i) => Number(i.sale_price) },
    { key: 'reorder_level', header: 'Reorder at', align: 'right', render: (i) => <span className="num">{Number(i.reorder_level)}</span> }
  ];

  return (
    <div>
      <PageHeader title="Inventory" sub="Stock items valued under FIFO and weighted average, side by side."
        actions={
          <>
            {canWrite && <button className="btn btn-ghost" onClick={() => setMoveModal(true)}><ArrowLeftRight className="h-4 w-4" /> Record movement</button>}
            {canCreateItem && <button className="btn btn-primary" onClick={() => setItemModal(true)}><Plus className="h-4 w-4" /> New item</button>}
          </>
        } />

      <div className="mb-4 flex gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-slate-800 dark:bg-slate-900 w-fit">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition
              ${tab === t.id ? 'bg-brand-950 text-white shadow' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {tab === 'items' && <DataTable columns={itemColumns} rows={items} loading={loading} empty="No items yet." />}
      {tab === 'stock' && <StockReport refresh={refresh} />}
      {tab === 'movements' && (
        <Movements refresh={refresh} canReverse={canReverse} onChanged={() => setRefresh(r => r + 1)} />
      )}

      <CreateItemModal open={itemModal} onClose={() => setItemModal(false)} onDone={() => { setItemModal(false); setRefresh(r => r + 1); }} />
      <MovementModal open={moveModal} onClose={() => setMoveModal(false)} items={items} warehouses={warehouses}
        suppliers={suppliers} booksBeginFrom={company?.books_begin_from}
        onDone={() => { setMoveModal(false); setRefresh(r => r + 1); }} />
    </div>
  );
}

function StockReport({ refresh }: { refresh: number }) {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api.get('/api/inventory/stock-report').then((r) => setRows(r.data.data)).finally(() => setLoading(false));
  }, [refresh]);

  const columns: Column<StockRow>[] = [
    { key: 'sku', header: 'SKU', render: (r) => <span className="num text-xs font-semibold">{r.sku}</span> },
    { key: 'name', header: 'Item' },
    { key: 'quantity', header: 'Qty', align: 'right', render: (r) => <span className="num">{r.quantity} {r.unit}</span>, sortValue: (r) => r.quantity },
    { key: 'fifo_value', header: 'FIFO value', align: 'right', render: (r) => <Money value={r.fifo_value} />, sortValue: (r) => r.fifo_value },
    { key: 'weighted_avg_value', header: 'Wtd. avg value', align: 'right', render: (r) => <Money value={r.weighted_avg_value} />, sortValue: (r) => r.weighted_avg_value },
    { key: 'avg_rate', header: 'Avg rate', align: 'right', render: (r) => <Money value={r.avg_rate} /> },
    { key: 'low_stock', header: 'Status', render: (r) => <Badge tone={r.low_stock ? 'rose' : 'green'}>{r.low_stock ? 'LOW STOCK' : 'OK'}</Badge> }
  ];
  return <DataTable columns={columns} rows={rows} loading={loading} empty="No stock to value." />;
}

function Movements({ refresh, canReverse, onChanged }:
  { refresh: number; canReverse: boolean; onChanged: () => void }) {
  const [reverseOf, setReverseOf] = useState<Movement | null>(null);
  const { rows, loading, paging, reload } = useServerList<Movement>(
    '/api/inventory/movements', {}, [refresh]);

  const columns: Column<Movement>[] = [
    { key: 'entry_date', header: 'Date', render: (m) => <span className="num">{fmtDate(m.entry_date)}</span>, sortValue: (m) => m.entry_date },
    { key: 'entry_type', header: 'Type', render: (m) => <Badge tone={statusTone(m.entry_type)}>{m.entry_type}</Badge> },
    { key: 'item_name', header: 'Item', render: (m) => <div><div className="font-medium">{m.item_name}</div><div className="num text-xs text-slate-400">{m.sku}</div></div> },
    { key: 'warehouse_name', header: 'Warehouse', render: (m) => (
        <div>
          <div>{m.warehouse_name}</div>
          {m.supplier_name && <div className="text-xs text-slate-400">from {m.supplier_name}</div>}
        </div>) },
    { key: 'quantity', header: 'Qty', align: 'right', render: (m) => <span className="num">{Number(m.quantity)}</span>, sortValue: (m) => Number(m.quantity) },
    { key: 'rate', header: 'Unit cost', align: 'right', render: (m) => <Money value={m.rate} /> },
    { key: 'value_amount', header: 'Value', align: 'right', render: (m) => <Money value={m.value_amount} />, sortValue: (m) => Number(m.value_amount) },
    // The voucher column is the point of the whole integration: every movement
    // now has a posting behind it, and you can see which one.
    { key: 'voucher_no', header: 'Voucher', render: (m) => (
        m.voucher_no
          ? <span className="num text-xs">{m.voucher_no}</span>
          : <span className="text-xs text-slate-400">—</span>) },
    { key: 'actions', header: '', align: 'right', sortable: false, render: (m) => (
        m.voucher_status === 'REVERSED'
          ? <Badge tone="slate">REVERSED</Badge>
          : canReverse && m.voucher_no
            ? <button className="btn btn-ghost !px-2 !py-1 text-xs" onClick={() => setReverseOf(m)}>
                <Undo2 className="h-3.5 w-3.5" /> Reverse
              </button>
            : null) }
  ];

  return (
    <>
      <DataTable columns={columns} rows={rows} loading={loading} paging={paging} empty="No stock movements yet." />
      <ReverseModal
        open={!!reverseOf}
        onClose={() => setReverseOf(null)}
        onDone={() => { setReverseOf(null); reload(); onChanged(); }}
        endpoint={`/api/inventory/movements/${reverseOf?.id}/reverse`}
        title="Reverse stock movement"
        what={`the ${reverseOf?.entry_type} of ${Number(reverseOf?.quantity ?? 0)} ${reverseOf?.item_name ?? ''}`}
        warning="An opposite stock entry is written at the original value, so both the ledger and the stock journal return to where they stood."
      />
    </>
  );
}

function CreateItemModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ sku: '', name: '', category: '', unit: 'pcs', purchasePrice: '', salePrice: '', reorderLevel: '0' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/inventory/items', {
        sku: form.sku, name: form.name, category: form.category || undefined, unit: form.unit,
        purchasePrice: Number(form.purchasePrice) || 0, salePrice: Number(form.salePrice) || 0,
        reorderLevel: Number(form.reorderLevel) || 0
      });
      setForm({ sku: '', name: '', category: '', unit: 'pcs', purchasePrice: '', salePrice: '', reorderLevel: '0' });
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="New Item">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU"><input className="input num" value={form.sku} onChange={set('sku')} required placeholder="TF-XXX" /></Field>
          <Field label="Unit"><input className="input" value={form.unit} onChange={set('unit')} required /></Field>
        </div>
        <Field label="Item name"><input className="input" value={form.name} onChange={set('name')} required minLength={2} /></Field>
        <Field label="Category"><input className="input" value={form.category} onChange={set('category')} placeholder="Optional" /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Purchase price"><input className="input num" type="number" min="0" step="0.01" value={form.purchasePrice} onChange={set('purchasePrice')} required /></Field>
          <Field label="Sale price"><input className="input num" type="number" min="0" step="0.01" value={form.salePrice} onChange={set('salePrice')} required /></Field>
          <Field label="Reorder level"><input className="input num" type="number" min="0" value={form.reorderLevel} onChange={set('reorderLevel')} /></Field>
        </div>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Create item'}</button>
        </div>
      </form>
    </Modal>
  );
}

const emptyMovement = () => ({
  itemId: '', warehouseId: '', supplierId: '', type: 'IN' as 'IN' | 'OUT',
  quantity: '', rate: '', date: today(), note: '',
});

function MovementModal({ open, onClose, items, warehouses, suppliers, booksBeginFrom, onDone }:
  { open: boolean; onClose: () => void; items: Item[]; warehouses: Warehouse[];
    suppliers: Lookup[]; booksBeginFrom?: string | null; onDone: () => void }) {
  const [form, setForm] = useState(emptyMovement);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isOut = form.type === 'OUT';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/api/inventory/movements', {
        itemId: Number(form.itemId), warehouseId: Number(form.warehouseId), type: form.type,
        quantity: Number(form.quantity),
        // An issue is costed by the books, not by whatever is typed here.
        rate: isOut ? 0 : Number(form.rate) || 0,
        supplierId: !isOut && form.supplierId ? Number(form.supplierId) : undefined,
        date: form.date, note: form.note || undefined,
      });
      setForm(emptyMovement());
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Record Stock Movement">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {isOut
            ? 'Issuing stock posts Dr Cost of Goods Sold / Cr Stock in Hand at weighted-average cost.'
            : form.supplierId
              ? 'Receiving stock posts Dr Stock in Hand / Cr the supplier’s payable account.'
              : 'Receiving stock posts Dr Stock in Hand / Cr Stock Adjustment. Name a supplier to book a real payable instead.'}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Direction">
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'IN' | 'OUT' })}>
              <option value="IN">IN — purchase / receive</option>
              <option value="OUT">OUT — issue / sell</option>
            </select>
          </Field>
          <Field label="Date">
            <input type="date" className="input num" value={form.date} required
              min={booksBeginFrom ?? undefined} max={today()}
              onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
        </div>
        <Field label="Item">
          <select className="input" value={form.itemId} onChange={(e) => setForm({ ...form, itemId: e.target.value })} required>
            <option value="">Select item…</option>
            {items.map((i) => <option key={i.id} value={i.id}>{i.sku} — {i.name} (stock: {Number(i.stock_qty)})</option>)}
          </select>
        </Field>
        <Field label="Warehouse" hint={isOut ? 'Stock is checked in this warehouse alone' : undefined}>
          <select className="input" value={form.warehouseId} onChange={(e) => setForm({ ...form, warehouseId: e.target.value })} required>
            <option value="">Select warehouse…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
        {!isOut && (
          <Field label="Supplier" hint="Optional — books the payable on their account">
            <select className="input" value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>
              <option value="">None — post to Stock Adjustment</option>
              {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity"><input className="input num" type="number" min="0.001" step="0.001" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} required /></Field>
          {!isOut && (
            <Field label="Rate (per unit)" hint="What it cost us">
              <input className="input num" type="number" min="0.01" step="0.01" value={form.rate}
                onChange={(e) => setForm({ ...form, rate: e.target.value })} required />
            </Field>
          )}
        </div>
        <Field label="Note"><input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="Optional" /></Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Record movement'}</button>
        </div>
      </form>
    </Modal>
  );
}
