import { FormEvent, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { api, apiErrorMessage } from '../api/client';
import { ErrorNote, Field, Modal } from './ui';
import { today } from '../lib/format';

/**
 * The one dialog behind every correction in the system.
 *
 * Nothing here is ever edited or deleted. Reversing posts a NEW voucher that
 * mirrors the original — both stay on the books, linked in both directions —
 * so the audit trail keeps the mistake AND its correction. That is why a
 * reason is mandatory: the trail is worthless without one.
 *
 * The reversal is dated today by default rather than backdated to the
 * original, which is what lets a mistake inside a closed period be corrected
 * without reopening it.
 */
export default function ReverseModal({
  open, onClose, onDone, endpoint, title, what, warning,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  /** POST target, e.g. `/api/payments/12/reverse`. */
  endpoint: string;
  title: string;
  /** Human description of the thing being reversed, e.g. "payment PMT-…". */
  what: string;
  /** Extra consequence worth spelling out before the button is pressed. */
  warning?: string;
}) {
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post(endpoint, { reason: reason.trim(), date });
      setReason('');
      onDone();
    } catch (err) { setError(apiErrorMessage(err)); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          This posts a mirrored voucher against <span className="font-semibold">{what}</span>.
          Nothing is edited or deleted — both the original and its reversal stay on the books.
        </p>
        {warning && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            {warning}
          </div>
        )}
        <Field label="Reason" hint="Recorded in the audit trail — required">
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)}
            required minLength={1} maxLength={255} placeholder="Recorded against the wrong customer" />
        </Field>
        <Field label="Reversal date" hint="Posts in the open period — the original stays where it was filed">
          <input type="date" className="input num" value={date} max={today()}
            onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !reason.trim()}>
            <Undo2 className="h-4 w-4" /> {busy ? 'Posting…' : 'Post reversal'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
