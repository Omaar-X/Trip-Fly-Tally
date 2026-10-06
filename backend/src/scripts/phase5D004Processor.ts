import { pool, Row, withTransaction } from '../config/db';
import { env } from '../config/env';

/**
 * ============ D004 · POSSIBLE DUPLICATES, REISSUES AND REFUNDS =============
 *
 * D004 = A with B fallback. Each of the 57 candidates is examined against its
 * own ticket/reference family, and a verdict is recorded ONLY where the source
 * itself proves the answer. Anything short of proof keeps its
 * POSSIBLE_DUPLICATE flag as a visible historical limitation.
 *
 * The rule that decides everything here: a duplicate is the SAME transaction
 * posted twice. That has a signature — same ticket, same passenger, same sign,
 * same amount. Not one of the 57 candidates has it. What they have instead is
 * one of two provable patterns:
 *
 *   R1 · A NEGATIVE line against the same real ticket number as an earlier
 *        POSITIVE line that is already in the books. Opposite signs cannot be
 *        the same transaction entered twice; this is the source's own refund,
 *        void or reissue credit against the original sale.
 *
 *   R2 · A shared reference that is NOT a ticket number — "REFUND",
 *        "REFUND ADJUST", or a 6-character PNR — where the rows carry
 *        DIFFERENT passengers. The grouping key never identified a
 *        transaction, so the rows were never duplicate candidates; a PNR
 *        legitimately covers several travellers on one booking.
 *
 * Everything else — same ticket, same passenger, same sign, different amount —
 * is a reissue, a fare correction or a re-entry, and the surviving rows do not
 * say which. Those stay OPEN (Option B).
 *
 * No journal is posted and no source row is deleted or altered. CONFIRMED_
 * DUPLICATE is never applied by this script: confirming one requires evidence
 * the source does not contain, and the consequence would be a reversal.
 *
 * ── One thing this script deliberately makes louder ────────────────────────
 *
 * All 57 candidates are UNPOSTED (status REVIEW_REQUIRED). Clearing the
 * duplicate question therefore does not put them in the books — it answers
 * "is this a duplicate?" with "no", and leaves "why is a genuine transaction
 * missing from the ledger?" unanswered. Resolving the only review item on the
 * row would make that second question invisible, so every cleared row is given
 * a fresh, material follow-up item recording exactly that. A visible
 * unresolved limitation beats a quietly closed one.
 */

const TITLES = /\b(MR|MRS|MS|MISS|MSTR|MD)\b/g;

const normalizePax = (value: unknown): string => {
  const text = String(value ?? '').toUpperCase().replace(/[^A-Z ]/g, ' ').replace(TITLES, ' ');
  return [...new Set(text.split(/\s+/).filter(Boolean))].sort().join(' ');
};

const paxOf = (raw: Record<string, unknown> | null): string => {
  if (!raw) return '';
  for (const key of ['NAME', 'Pax Name', 'PASSENGER', 'Passenger', 'PAX NAME']) {
    if (raw[key]) return normalizePax(raw[key]);
  }
  return '';
};

/** A real ticket number, as opposed to a label like REFUND or a 6-char PNR. */
const isTicketNumber = (ref: string | null): boolean =>
  !!ref && /\d{6,}/.test(ref.replace(/[\s-]/g, ''));

const parseRaw = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === 'object') return value as Record<string, unknown>;
  try { return JSON.parse(String(value)) as Record<string, unknown>; } catch { return null; }
};

const FOLLOW_UP_TYPE = 'UNPOSTED_CLEARED_HISTORICAL_TRANSACTION';

interface Verdict {
  action: 'CLEARED_NOT_DUPLICATE' | 'NEEDS_MORE_EVIDENCE';
  ruleCode: string;
  evidence: string;
}

async function main(): Promise<void> {
  if (env.isProduction || !/staging/i.test(env.db.database))
    throw new Error(`Refusing D004 processing on non-staging database: ${env.db.database}`);

  const actorId = Number(process.env.PHASE5_ACTOR_USER_ID);
  if (!Number.isInteger(actorId) || actorId < 1) throw new Error('PHASE5_ACTOR_USER_ID is required.');
  const dryRun = process.argv.includes('--dry-run');

  const outcome = await withTransaction(async (conn) => {
    const [candidates] = await conn.query<Row[]>(
      `SELECT i.id AS review_id, i.impact_amount, r.*
         FROM migration_review_items i
         JOIN migration_source_rows r ON r.id = i.source_row_id
        WHERE i.company_id = 1 AND i.issue_type = 'POSSIBLE_DUPLICATE' AND i.status = 'OPEN'
        ORDER BY i.id
        FOR UPDATE`);

    const tally: Record<string, { rows: number; amount: number }> = {};
    const count = (code: string, amount: number) => {
      const bucket = tally[code] ?? { rows: 0, amount: 0 };
      bucket.rows++; bucket.amount += Math.abs(amount); tally[code] = bucket;
    };

    let cleared = 0; let kept = 0; let followUps = 0;

    for (const row of candidates) {
      const amount = Number(row.source_amount ?? 0);
      const ref = row.source_ref ? String(row.source_ref) : null;
      const pnr = row.pnr ? String(row.pnr) : null;
      const pax = paxOf(parseRaw(row.raw));

      // The family: every other source row sharing this row's ticket or PNR.
      const [family] = await conn.query<Row[]>(
        `SELECT id, source_date, source_sheet, source_row, source_ref, pnr,
                source_amount, status, raw
           FROM migration_source_rows
          WHERE company_id = ? AND id <> ?
            AND ((? IS NOT NULL AND source_ref = ?) OR (? IS NOT NULL AND pnr = ?))
          ORDER BY source_date, source_row`,
        [row.company_id, row.id, ref, ref, pnr, pnr]);

      let verdict: Verdict;

      const reversedOriginal = family.find((f) =>
        isTicketNumber(ref)
        && String(f.source_ref ?? '') === ref
        && Number(f.source_amount ?? 0) > 0
        && amount < 0);

      const sharedKeyRows = family.filter((f) =>
        String(f.source_ref ?? '') === ref || (pnr && String(f.pnr ?? '') === pnr));
      const allDifferentPassengers = sharedKeyRows.length > 0
        && sharedKeyRows.every((f) => paxOf(parseRaw(f.raw)) !== pax);

      if (reversedOriginal) {
        verdict = {
          action: 'CLEARED_NOT_DUPLICATE',
          ruleCode: 'D004_SIGNED_REVERSAL_SAME_TICKET',
          evidence:
            `Ticket ${ref} carries an earlier positive line of ${Number(reversedOriginal.source_amount).toFixed(2)} `
            + `(${reversedOriginal.source_sheet} row ${reversedOriginal.source_row}, status `
            + `${reversedOriginal.status}) and this negative line of ${amount.toFixed(2)}. Opposite signs on the `
            + 'same ticket cannot be one transaction entered twice; this is the source\'s own refund, void or '
            + 'reissue credit against that sale. Genuine transaction, not a duplicate.',
        };
      } else if (!isTicketNumber(ref) && allDifferentPassengers) {
        verdict = {
          action: 'CLEARED_NOT_DUPLICATE',
          ruleCode: 'D004_NON_TICKET_REFERENCE_DISTINCT_PASSENGER',
          evidence:
            `The shared reference "${ref}" is not a ticket number — it is a label or a booking PNR — and every `
            + `row sharing it names a different passenger (this row: ${pax || 'unnamed'}). The grouping key never `
            + 'identified a transaction, so these are separate valid transactions rather than duplicate postings.',
        };
      } else {
        verdict = {
          action: 'NEEDS_MORE_EVIDENCE',
          ruleCode: 'D004_INSUFFICIENT_EVIDENCE',
          evidence:
            `Ticket ${ref ?? '(none)'} repeats for the same passenger with a different amount and the same sign. `
            + 'That is consistent with a reissue, a fare correction or a re-entry, and the surviving rows do not '
            + 'establish which. Airline/agency statement evidence is required. Kept as POSSIBLE_DUPLICATE.',
        };
      }

      count(verdict.ruleCode, amount);
      if (verdict.action === 'CLEARED_NOT_DUPLICATE') cleared++; else kept++;

      if (dryRun) continue;

      // A re-run must not append the same verdict again. An unchanged
      // NEEDS_MORE_EVIDENCE item is still open on the next run, and logging it
      // each time would turn the audit trail into a count of how often the
      // script was executed.
      const [logged] = await conn.query<Row[]>(
        `SELECT id FROM historical_review_actions
          WHERE company_id = ? AND review_item_id = ? AND action_code = ? AND rule_code = ?
          LIMIT 1`,
        [row.company_id, row.review_id, verdict.action, verdict.ruleCode]);
      if (logged.length) continue;

      await conn.query(
        `INSERT INTO historical_review_actions
           (company_id, review_item_id, action_code, prior_status, resulting_status,
            evidence, rule_code, actor_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [row.company_id, row.review_id, verdict.action, 'OPEN',
         verdict.action === 'CLEARED_NOT_DUPLICATE' ? 'RESOLVED' : 'OPEN',
         verdict.evidence, verdict.ruleCode, actorId]);

      if (verdict.action !== 'CLEARED_NOT_DUPLICATE') continue;

      await conn.query(
        `UPDATE migration_review_items
            SET status = 'RESOLVED', resolution = ?, resolution_code = 'CLEARED_NOT_DUPLICATE',
                resolved_by = ?, resolved_at = NOW()
          WHERE company_id = ? AND id = ?`,
        [verdict.evidence, actorId, row.company_id, row.review_id]);

    }

    // ── Follow-up pass ──────────────────────────────────────────────────────
    //
    // Every row cleared by D004 that is NOT in the books gets its own visible,
    // material item. Run as a separate sweep over all cleared rows rather than
    // inline, so it also repairs a run where the verdict landed and the
    // follow-up did not — and so a re-run is a no-op rather than a duplicate.
    const [clearedUnposted] = await conn.query<Row[]>(
      `SELECT r.id, r.company_id, r.batch_id, r.source_file, r.source_sheet, r.source_row,
              r.source_amount
         FROM migration_review_items i
         JOIN migration_source_rows r ON r.id = i.source_row_id
        WHERE i.company_id = 1 AND i.resolution_code = 'CLEARED_NOT_DUPLICATE'
          AND r.status = 'REVIEW_REQUIRED' AND r.target_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM migration_review_items f
             WHERE f.company_id = r.company_id AND f.source_row_id = r.id
               AND f.issue_type = ?)
        ORDER BY r.id
        FOR UPDATE`,
      [FOLLOW_UP_TYPE]);

    for (const row of clearedUnposted) {
      const amount = Number(row.source_amount ?? 0);
      if (dryRun) { followUps++; continue; }
      await conn.query(
        `INSERT INTO migration_review_items
           (company_id, batch_id, source_row_id, module, issue_type, is_material,
            impact_amount, source_ref, issue, proposed)
         VALUES (?,?,?,?,?,1,?,?,?,?)`,
        [row.company_id, row.batch_id, row.id, 'MIGRATION', FOLLOW_UP_TYPE,
         Math.abs(amount),
         `${row.source_file} · ${row.source_sheet} · row ${row.source_row}`,
         `D004 cleared this row as a genuine transaction rather than a duplicate, but it was never posted `
         + `(source amount ${amount.toFixed(2)}). The books therefore do not contain it. Its absence is a `
         + 'real difference against the source and must not be closed by the duplicate verdict alone.',
         'Decide whether to post this transaction through the audited historical path, or accept its '
         + 'absence as a stated historical limitation with a CEO reason.']);
      followUps++;
    }

    return { candidates: candidates.length, cleared, kept, followUps, tally };
  });

  console.log(JSON.stringify({ database: env.db.database, dryRun, ...outcome }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
