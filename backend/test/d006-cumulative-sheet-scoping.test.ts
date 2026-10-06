import { describe, it, expect } from 'vitest';
import {
  isCumulativeSheetRepeat, transactionIdentity, CUMULATIVE_DUPLICATE_REASON,
} from '../src/modules/migration/runner';
import { NormalizedRow } from '../src/modules/migration/parser';

/**
 * D006 · cumulative day-book sheets.
 *
 * `Daily Statement NOV'24` carries 179 October-dated rows, `Daily Statement
 * OCT'24` carries 80 November-dated ones, and `JUN-25` repeats 80 May-2025
 * rows. `natural_key` includes the sheet name, so the same transaction from two
 * sheets never collided and posted twice — BDT 39,167,396.76 across 341 pairs.
 *
 * These tests pin the rule that fixes it AND, just as importantly, the two
 * things it must never do: merge coincidentally-similar transactions, or lose
 * a row's lineage.
 */

const row = (over: Partial<NormalizedRow> = {}): NormalizedRow => ({
  outcome: 'FINANCIAL',
  kind: 'PAYMENT',
  rowKind: 'DATA',
  source: { file: "Daily Books.xlsx", archive: '', sheet: "Daily Statement NOV'24", row: 132, period: '2024-11' },
  raw: {},
  date: '2024-10-15',
  customerText: 'LOAN PAID TO RAZIB SIR',
  costAmount: 1000000,
  ...over,
});

const octoberContains = (r: NormalizedRow) =>
  new Map([['2024-10', new Set([transactionIdentity(r)])]]);

describe('D006 · a cumulative sheet repeat posts once', () => {
  it('suppresses an October transaction copied into the November sheet', () => {
    const carried = row();
    expect(isCumulativeSheetRepeat(carried, '2024-11', octoberContains(carried))).toBe(true);
  });

  it('posts the same transaction when October itself is the period being run', () => {
    // The original line, in its own month's batch. This is the copy that must
    // survive — suppressing both would lose the transaction entirely.
    const original = row({
      source: { file: "Daily Books.xlsx", archive: '', sheet: "Daily Statement OCT'24", row: 84, period: '2024-10' },
    });
    expect(isCumulativeSheetRepeat(original, '2024-10', octoberContains(original))).toBe(false);
  });

  it('identity ignores the sheet and row, which is what differs between copies', () => {
    const a = row({ source: { file: 'f', archive: '', sheet: "Daily Statement OCT'24", row: 84, period: '2024-10' } });
    const b = row({ source: { file: 'f', archive: '', sheet: "Daily Statement NOV'24", row: 132, period: '2024-11' } });
    expect(transactionIdentity(a)).toBe(transactionIdentity(b));
  });
});

describe('D006 · genuinely different transactions are never merged', () => {
  it('keeps two same-day, same-amount, same-party transactions inside one period', () => {
    // The exact case the rule must not touch: a customer paying the same
    // amount twice on one day. Both rows sit inside their own period, so the
    // suppression test cannot reach them however identical they look.
    const first = row({
      date: '2024-11-03', customerText: 'HAQUE GROUP', costAmount: 25116,
      source: { file: 'f', archive: '', sheet: "Daily Statement NOV'24", row: 40, period: '2024-11' },
    });
    const second = row({
      date: '2024-11-03', customerText: 'HAQUE GROUP', costAmount: 25116,
      source: { file: 'f', archive: '', sheet: "Daily Statement NOV'24", row: 91, period: '2024-11' },
    });
    expect(transactionIdentity(first)).toBe(transactionIdentity(second));

    const foreign = new Map([['2024-11', new Set([transactionIdentity(first)])]]);
    expect(isCumulativeSheetRepeat(first, '2024-11', foreign)).toBe(false);
    expect(isCumulativeSheetRepeat(second, '2024-11', foreign)).toBe(false);
  });

  it('posts an out-of-period row whose month has no matching transaction', () => {
    // A carry-over line with no twin is a genuine transaction that only this
    // sheet recorded. Silence in the other month is not evidence of a twin.
    const orphan = row({ date: '2024-10-15', costAmount: 999 });
    expect(isCumulativeSheetRepeat(orphan, '2024-11', new Map())).toBe(false);
    expect(isCumulativeSheetRepeat(orphan, '2024-11',
      new Map([['2024-10', new Set(['something-else'])]]))).toBe(false);
  });

  it('does not suppress a differing amount, party, kind or day-book side', () => {
    const original = row();
    const foreign = octoberContains(original);
    expect(isCumulativeSheetRepeat(row({ costAmount: 1000001 }), '2024-11', foreign)).toBe(false);
    expect(isCumulativeSheetRepeat(row({ customerText: 'LOAN PAID TO SOMEONE ELSE' }), '2024-11', foreign)).toBe(false);
    expect(isCumulativeSheetRepeat(row({ kind: 'RECEIPT' }), '2024-11', foreign)).toBe(false);
    expect(isCumulativeSheetRepeat(row({ raw: { __side: 'RECEIPT' } }), '2024-11', foreign)).toBe(false);
  });

  it('never suppresses a non-financial or undated row', () => {
    const original = row();
    const foreign = octoberContains(original);
    expect(isCumulativeSheetRepeat(row({ outcome: 'NON_TRANSACTION' }), '2024-11', foreign)).toBe(false);
    expect(isCumulativeSheetRepeat(row({ date: null }), '2024-11', foreign)).toBe(false);
  });
});

describe('D006 · lineage survives suppression', () => {
  it('names the reason a suppressed row carries, so both sheets stay evidence', () => {
    // The suppressed row is staged with its own file, sheet and row number and
    // this reason. It is never deleted, so the November sheet remains readable
    // as the source it was.
    expect(CUMULATIVE_DUPLICATE_REASON).toBe('CUMULATIVE_SHEET_DUPLICATE_NOT_POSTED');
  });

  it('party text is compared case- and whitespace-insensitively, not rewritten', () => {
    const a = row({ customerText: 'LOAN PAID TO RAZIB SIR' });
    const b = row({ customerText: '  loan   paid to razib sir ' });
    expect(transactionIdentity(a)).toBe(transactionIdentity(b));
    // The row itself keeps whatever the source said.
    expect(b.customerText).toBe('  loan   paid to razib sir ');
  });
});
