import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { ROLE, RoleName, hasAnyRole } from '../lib/roles';
import { Field, Modal, SearchOption, SearchSelect } from './ui';

/**
 * Party pickers backed by the server.
 *
 * The ledger and item pickers hand SearchSelect a full array, which is right
 * while the set is a few hundred rows. Customers are not that: the historical
 * import alone brings in every party the company has traded with since 2024,
 * and the list endpoint that fed these dropdowns aggregates every voucher
 * entry in the book to compute an outstanding balance per row. Paying for that
 * on page load, to fill a control the user types three letters into, is the
 * thing Phase 2 exists to stop.
 *
 * So: /search on each keystroke, capped, debounced, and the label of the
 * current selection carried separately from the result page.
 */

export interface PartyRef {
  id: number;
  name: string;
  phone?: string | null;
  email?: string | null;
}

const PAGE_SIZE = 25;

const toOption = (p: PartyRef): SearchOption => ({
  value: p.id,
  // Phone doubles as the disambiguator when two parties share a name — which
  // is exactly when a picker is least useful without one.
  hint: p.phone || undefined,
  label: p.name,
});

// ─────────────────────────── generic picker ─────────────────────────────────

export function EntitySearchSelect({
  kind, value, onChange, placeholder, required, disabled, ariaLabel, emptyLabel,
  className = '', quickAdd = true, initialOption = null,
}: {
  kind: 'customer' | 'supplier';
  value: number | '' | null;
  onChange: (id: number | '') => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  emptyLabel?: string;
  className?: string;
  quickAdd?: boolean;
  /**
   * The party behind `value` when a form opens already holding one — an edit
   * screen, or a payment prefilled from an invoice. Without it the control
   * knows the id but not the name, and the search endpoint cannot be asked
   * "what is #47" because it answers queries, not lookups.
   */
  initialOption?: PartyRef | null;
}) {
  const { user } = useAuth();
  const [selected, setSelected] = useState<PartyRef | null>(null);
  const [adding, setAdding] = useState(false);

  const path = kind === 'customer' ? '/api/crm/customers' : '/api/crm/suppliers';
  const label = kind === 'customer' ? 'Customer' : 'Vendor';

  // Who may create one mirrors the POST route's own guard; CEO bypasses.
  const createRoles: RoleName[] = kind === 'customer'
    ? [ROLE.SALES, ROLE.ACCOUNTANT, ROLE.ADMIN]
    : [ROLE.ACCOUNTANT, ROLE.ADMIN];
  const mayCreate = quickAdd && hasAnyRole(user?.role, createRoles);

  // A cleared value must clear the label with it, and a form that opens on an
  // existing party adopts the name its parent already knows.
  useEffect(() => {
    if (value === '' || value == null) { setSelected(null); return; }
    if (initialOption && initialOption.id === value) setSelected(initialOption);
  }, [value, initialOption]);

  const loadOptions = useCallback(
    async (query: string, signal: AbortSignal): Promise<SearchOption[]> => {
      const r = await api.get(`${path}/search`, {
        params: { q: query, limit: PAGE_SIZE }, signal,
      });
      const rows = r.data.data as PartyRef[];
      // Remember the rows so picking one can restore its full record without
      // another round trip.
      lastPage.set(path, rows);
      return rows.map(toOption);
    },
    [path]);

  const handleChange = (raw: string) => {
    if (raw === '') { setSelected(null); onChange(''); return; }
    const id = Number(raw);
    const hit = (lastPage.get(path) ?? []).find((p) => p.id === id) ?? null;
    setSelected(hit);
    onChange(id);
  };

  return (
    <>
      <SearchSelect
        ariaLabel={ariaLabel ?? label}
        className={className}
        value={value ?? ''}
        onChange={handleChange}
        loadOptions={loadOptions}
        selectedOption={selected ? toOption(selected) : null}
        pageSize={PAGE_SIZE}
        placeholder={placeholder ?? `Type to find a ${label.toLowerCase()}…`}
        required={required}
        disabled={disabled}
        emptyLabel={emptyLabel}
        footer={mayCreate ? (
          <button
            type="button"
            // mousedown, not click: a click would blur the input and unmount
            // the list before the handler ever ran.
            onMouseDown={(e) => { e.preventDefault(); setAdding(true); }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm font-medium text-brand-600 hover:bg-brand-50 dark:text-brand-400 dark:hover:bg-brand-950/40"
          >
            <Plus className="h-3.5 w-3.5" /> Add new {label.toLowerCase()}
          </button>
        ) : undefined}
      />

      {adding && (
        <QuickAddParty
          kind={kind}
          onClose={() => setAdding(false)}
          onCreated={(party) => {
            setAdding(false);
            // Auto-select, and seed the cache so the label survives a reopen
            // without waiting for the next search.
            lastPage.set(path, [party, ...(lastPage.get(path) ?? [])]);
            setSelected(party);
            onChange(party.id);
          }}
        />
      )}
    </>
  );
}

/**
 * The last page of results per endpoint, so picking a row can recover its full
 * record. Module-level rather than state because two pickers on the same form
 * (customer and supplier on a booking) query the same endpoints and there is
 * nothing to gain from each holding its own copy.
 */
const lastPage = new Map<string, PartyRef[]>();

export const CustomerSearchSelect = (
  props: Omit<Parameters<typeof EntitySearchSelect>[0], 'kind'>,
) => <EntitySearchSelect kind="customer" {...props} />;

export const VendorSearchSelect = (
  props: Omit<Parameters<typeof EntitySearchSelect>[0], 'kind'>,
) => <EntitySearchSelect kind="supplier" {...props} />;

// ──────────────────────────── quick add ─────────────────────────────────────

/**
 * Creating a party without leaving the transaction being typed.
 *
 * The half-filled booking behind this modal is the whole point: someone is
 * mid-entry, the customer is not on file, and sending them to the CRM page to
 * make one would throw the entry away.
 */
export function QuickAddParty({
  kind, onClose, onCreated,
}: {
  kind: 'customer' | 'supplier';
  onClose: () => void;
  onCreated: (party: PartyRef) => void;
}) {
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = kind === 'customer' ? '/api/crm/customers' : '/api/crm/suppliers';
  const label = kind === 'customer' ? 'customer' : 'vendor';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { name: form.name.trim() };
      if (form.phone.trim()) body.phone = form.phone.trim();
      if (form.email.trim()) body.email = form.email.trim();
      if (kind === 'customer') body.creditLimit = 0;

      const r = await api.post(path, body);
      const created = r.data.data as { id: number };
      onCreated({ id: created.id, name: form.name.trim(), phone: form.phone.trim() || null });
    } catch (err: any) {
      // A 409 here is the duplicate guard doing its job — the message names
      // the party that already exists, which is what the user needs to read.
      setError(err?.response?.data?.message ?? `Could not create the ${label}.`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`New ${label}`}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <input
            className="input" autoFocus required minLength={2} maxLength={150}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone">
            <input
              className="input" maxLength={30} value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <Field label="Email">
            <input
              className="input" type="email" maxLength={150} value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
        </div>

        {error && (
          <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={saving || form.name.trim().length < 2}>
            {saving ? 'Saving…' : `Save ${label}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
