import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  AGENT_ALIASES, CUSTOMER_ALIASES, EXPENSE_TOKENS, KNOWN_CUSTOMERS, KNOWN_SUPPLIERS,
  LEDGER,
  assessDrawings, assessDuplicate, classifyAgencyToken, classifyClientToken,
  classifyReferenceToken, classifyService, commissionFromSource, naturalKey, normalizeToken,
} from '../src/modules/migration/historicalRules';

/**
 * These are the Phase 3 business corrections. Each one overturned an earlier
 * classification that would have put real money on the wrong ledger, so they
 * are asserted individually rather than as a table — a failure here should name
 * the rule that broke.
 */

// ────────────────────────────── HAZEE (§1) ──────────────────────────────────

describe('HAZEE is a vendor', () => {
  it('classifies as a supplier from the agency column', () => {
    expect(classifyAgencyToken('HAZEE')).toEqual({ type: 'SUPPLIER', name: 'HAZEE' });
  });

  it('treats the HAJEE spelling as the same vendor', () => {
    expect(classifyAgencyToken('hajee')).toEqual({ type: 'SUPPLIER', name: 'HAZEE' });
  });

  it('is never a customer and never a transaction type', () => {
    const asAgency = classifyAgencyToken('HAZEE');
    expect(asAgency.type).not.toBe('CUSTOMER');
    expect(asAgency.type).not.toBe('GL');
    expect(KNOWN_SUPPLIERS.HAZEE).toBe('HAZEE');
  });
});

// ─────────────────────────────── PDC (§1) ───────────────────────────────────

describe('PDC is an Air Force department, not a post-dated cheque', () => {
  it('is a genuine customer', () => {
    expect(classifyClientToken('PDC')).toEqual({ type: 'CUSTOMER', name: 'PDC (AIR FORCE)' });
  });

  it('is not excluded as a transaction type', () => {
    // Phase 2 read it as "post-dated cheque" and dropped the rows. Six sales
    // rows were being lost.
    expect(classifyClientToken('PDC').type).not.toBe('NONE');
    expect(KNOWN_CUSTOMERS.PDC).toBeDefined();
  });
});

// ────────────────────────── ADM and VOID (§1) ───────────────────────────────

describe('ADM and VOID are company losses, not rows to discard', () => {
  it.each(['ADM', 'VOID'])('%s carries an airline-penalty treatment', (token) => {
    const c = classifyClientToken(token);
    expect(c.type).toBe('GL');
    expect(c.treatment).toBe('AIRLINE_PENALTY');
  });

  it('keeps them out of the party master without dropping the money', () => {
    // GL means "post it to a ledger", not "forget it". 40 rows across the set.
    expect(classifyClientToken('ADM').name).toBe('ADM');
    expect(Object.keys(EXPENSE_TOKENS)).toEqual(['ADM', 'VOID']);
  });

  it('posts each to its OWN ledger under the shared parent', () => {
    // Same nature, two ledgers: "what did ADMs cost us" and "what did voids
    // cost us" are different questions.
    expect(classifyClientToken('ADM').ledger).toBe(LEDGER.ADM);
    expect(classifyClientToken('VOID').ledger).toBe(LEDGER.VOID);
    expect(classifyClientToken('ADM').ledger).not.toBe(classifyClientToken('VOID').ledger);
  });
});

// ──────────────────────── CEO Drawings (Phase 3 decision) ───────────────────

describe('CEO Drawings is not a default destination', () => {
  it('posts to Drawings where the source says withdrawal', () => {
    // "WITHDRAWN FROM RAZIB SIR" / "RAZIB SIR WITHDRAWN" appear in every
    // month-end sheet and day book.
    const v = assessDrawings('RAJIB SIR PERSONAL', 'RAZIB SIR WITHDRAWN');
    expect(v).toMatchObject({ drawings: true, ledger: LEDGER.CEO_DRAWINGS });
  });

  it.each([
    'RAJIB SIR PERSONAL ( CARD PAYMENT )',
    'Owner withdrawal for the month',
    'Drawings — personal',
  ])('recognises %s as a drawing', (text) => {
    expect(assessDrawings('RAJIB SIR PERSONAL', text).drawings).toBe(true);
  });

  it('does NOT auto-post a RAJIB SIR PERSONAL row just because of the party', () => {
    // The trap this rule exists to close: a personal-account ticket that the
    // source shows as an ordinary credit sale is a receivable, not a
    // withdrawal. Routing it to Drawings would move real money off debtors.
    const v = assessDrawings('RAJIB SIR PERSONAL', 'DAC/DXB air ticket');
    expect(v.drawings).toBe(false);
  });

  it('does NOT auto-post a RAJIB SIR HAJJ row either', () => {
    expect(assessDrawings('RAJIB SIR HAJJ', 'Umrah package for 4 pax').drawings).toBe(false);
  });

  it('parks a CEO-personal row the source says nothing about', () => {
    const v = assessDrawings('RAJIB SIR PERSONAL', '');
    expect(v).toMatchObject({ drawings: false, review: true });
    expect('reason' in v && v.reason).toMatch(/must not be assumed/i);
  });

  it('parks a RAJIB SIR HAJJ row the source says nothing about', () => {
    expect(assessDrawings('RAJIB SIR HAJJ', null)).toMatchObject({ drawings: false, review: true });
  });

  it('follows a stated non-drawing treatment instead of second-guessing it', () => {
    const v = assessDrawings('RAJIB SIR PERSONAL', '', 'SALES');
    expect(v).toEqual({ drawings: false, review: false });
  });

  it('leaves ordinary parties alone — nothing to decide, nothing to review', () => {
    expect(assessDrawings('SUN PHARMA', 'DAC/DXB air ticket')).toEqual({ drawings: false, review: false });
    expect(assessDrawings(null, null)).toEqual({ drawings: false, review: false });
  });

  it('still catches a withdrawal on a party that is not the CEO account', () => {
    // "MADAME EXPENSES" / a withdrawal booked against another name is still a
    // drawing if the source says so.
    expect(assessDrawings('TAHMINA BASHAR', 'MADAME personal withdrawal').drawings).toBe(true);
  });
});

// ─────────────────── RAJIB / RAZIB reference handling (§1) ──────────────────

describe('RAJIB / RAZIB is one person, and a reference is not a debt', () => {
  it('maps both spellings to one agent', () => {
    expect(classifyReferenceToken('RAJIB SIR')).toEqual({ type: 'AGENT', name: 'RAJIB SIR' });
    expect(classifyReferenceToken('RAZIB SIR')).toEqual({ type: 'AGENT', name: 'RAJIB SIR' });
  });

  it('never produces a receivable or a payable from the reference column', () => {
    const c = classifyReferenceToken('RAZIB SIR');
    expect(c.type).not.toBe('CUSTOMER');
    expect(c.type).not.toBe('SUPPLIER');
  });

  it('keeps RAJIB SIR PERSONAL as its own customer, not merged into the agent', () => {
    expect(classifyClientToken('RAJIB SIR PERSONAL'))
      .toEqual({ type: 'CUSTOMER', name: 'RAJIB SIR PERSONAL' });
    expect(classifyClientToken('RAZIB SIR PERSONAL').name).toBe('RAJIB SIR PERSONAL');
  });

  it('keeps RAJIB SIR HAJJ separate from RAJIB SIR PERSONAL', () => {
    expect(classifyClientToken('RAJIB SIR HAJJ').name).toBe('RAJIB SIR HAJJ');
    expect(classifyClientToken('RAJIB SIR HAJJ').name)
      .not.toBe(classifyClientToken('RAJIB SIR PERSONAL').name);
  });

  it('parks a bare RAJIB SIR in the CLIENT column instead of guessing', () => {
    // Same string, different column, different meaning — and in the client
    // column nobody can tell a buyer from a mis-keyed reference.
    const c = classifyClientToken('RAJIB SIR');
    expect(c.type).toBe('REVIEW_REQUIRED');
    expect(c.reason).toMatch(/ambiguous/i);
  });

  it('never creates commission from a reference name alone', () => {
    expect(commissionFromSource(null)).toEqual({ create: false });
    expect(commissionFromSource(0)).toEqual({ create: false });
    expect(commissionFromSource(undefined)).toEqual({ create: false });
  });

  it('creates commission only where the source states an amount', () => {
    expect(commissionFromSource(1500)).toEqual({ create: true, amount: 1500 });
  });
});

// ───────────────────────── ECO / GROUPO (§2) ────────────────────────────────

describe('ECO and GROUPO normalisation', () => {
  it('folds the ECO spellings into ECO SORCHING', () => {
    for (const v of ['ECO SORCHING', 'ECO SORCING', 'ECO SOURCING'])
      expect(classifyClientToken(v).name).toBe('ECO SORCHING');
  });

  it('folds every GROUPO spelling into GROUPO SOURCING', () => {
    // Phase 3 changed the canonical from GROUPO SORCHING, so the old canonical
    // is itself an alias now.
    for (const v of ['GROUPO SOURCING', 'GROUPO SORCING', 'GROUPO SORCHING', 'GROUP SORCHING'])
      expect(classifyClientToken(v).name).toBe('GROUPO SOURCING');
  });

  it('never merges ECO into GROUPO', () => {
    expect(classifyClientToken('ECO SORCHING').name)
      .not.toBe(classifyClientToken('GROUPO SOURCING').name);
  });
});

// ─────────────────────── no fuzzy auto-merge (§3) ───────────────────────────

describe('no fuzzy party auto-merge', () => {
  it('does not merge names that merely look alike', () => {
    // One character apart, two different companies.
    expect(normalizeToken('ECO SORCHING')).not.toBe(normalizeToken('GROUPO SOURCING'));
    expect(classifyClientToken('ECO SOURCING').name).toBe('ECO SORCHING');
    expect(classifyClientToken('GROUPO SOURCING').name).toBe('GROUPO SOURCING');
  });

  it('takes an unknown name at face value rather than attaching it to a similar one', () => {
    // "SUN PHARMACEUTICALS" is not folded into "SUN PHARMA" — that is a
    // judgement, and it has not been made.
    const c = classifyClientToken('SUN PHARMACEUTICALS');
    expect(c).toEqual({ type: 'CUSTOMER', name: 'SUN PHARMACEUTICALS' });
  });

  it('parks the ambiguous ones explicitly', () => {
    for (const v of ['RAZIB SIR PER', 'SUN PERSONAL', 'ECO SORCING PERSONAL', 'RAJIB SIR UNCLE'])
      expect(classifyClientToken(v).type).toBe('REVIEW_REQUIRED');
  });

  it('parks an unrecognised issuing agency rather than inventing a vendor', () => {
    const c = classifyAgencyToken('SOME NEW CONSOLIDATOR');
    expect(c.type).toBe('REVIEW_REQUIRED');
    expect(c.name).toBeNull();
  });
});

// ─────────────────────── service category (§6) ──────────────────────────────

describe('service category', () => {
  it("prefers the source's own category", () => {
    expect(classifyService('VISA', 'some air ticket wording')).toBe('VISA');
  });

  it('reads a clear description when the source has no category', () => {
    expect(classifyService(null, 'Umrah package for 4 pax')).toBe('HAJJ_UMRAH');
    expect(classifyService(null, 'DAC/DXB air ticket')).toBe('AIR_TICKET');
  });

  it('parks a description naming two services', () => {
    expect(classifyService(null, 'hotel and visa processing')).toBe('REVIEW_REQUIRED');
  });

  it('parks an empty description rather than defaulting to OTHER', () => {
    expect(classifyService(null, null)).toBe('REVIEW_REQUIRED');
    expect(classifyService('', '   ')).toBe('REVIEW_REQUIRED');
  });

  it('parks a source category it does not recognise instead of flattening it', () => {
    expect(classifyService('SOMETHING ELSE', null)).toBe('REVIEW_REQUIRED');
  });
});

// ───────────────── duplicate transaction detection (§23) ────────────────────

describe('duplicate detection needs evidence, not coincidence', () => {
  const base = { sourceFile: 'A.xlsx', sourceSheet: 'Sales', sourceRow: 10 };

  it('refuses the naive rule: same date + same amount is not a duplicate', () => {
    // A family of four on one booking produces four identical-looking rows.
    const a = { ...base, date: '2024-08-01', amount: 64870, party: 'SUN PHARMA', ticketNo: '111' };
    const b = { ...base, sourceRow: 11, date: '2024-08-01', amount: 64870, party: 'SUN PHARMA', ticketNo: '222' };
    expect(assessDuplicate(a, b)).toEqual({ duplicate: false, review: false });
  });

  it('confirms a duplicate when the ticket, date and amount all agree', () => {
    const a = { ...base, ticketNo: '2326208162472', date: '2024-12-02', amount: 64870 };
    const b = { sourceFile: 'B.xlsx', sourceSheet: 'Sales', sourceRow: 4, ticketNo: '2326208162472', date: '2024-12-02', amount: 64870 };
    const v = assessDuplicate(a, b);
    expect(v.duplicate).toBe(true);
  });

  it('sends a repeated ticket with a different amount to review, not to the bin', () => {
    // A reissue or a refund — collapsing it would delete a real transaction.
    const a = { ...base, ticketNo: '999', date: '2024-12-02', amount: 1000 };
    const b = { ...base, sourceRow: 20, ticketNo: '999', date: '2024-12-02', amount: 1200 };
    const v = assessDuplicate(a, b);
    expect(v).toMatchObject({ duplicate: false, review: true });
  });

  it('reviews a no-ticket match on date, amount and party', () => {
    const a = { ...base, date: '2024-12-02', amount: 5000, party: 'SUN PHARMA' };
    const b = { sourceFile: 'B.xlsx', sourceSheet: 'S', sourceRow: 3, date: '2024-12-02', amount: 5000, party: 'SUN PHARMA' };
    expect(assessDuplicate(a, b)).toMatchObject({ duplicate: false, review: true });
  });

  it('never calls a row a duplicate of itself', () => {
    const a = { ...base, ticketNo: '999', date: '2024-12-02', amount: 1000 };
    expect(assessDuplicate(a, a)).toEqual({ duplicate: false, review: false });
  });

  it('stores evidence with every verdict that is not a plain no', () => {
    const a = { ...base, ticketNo: '999', date: '2024-12-02', amount: 1000 };
    const b = { sourceFile: 'B.xlsx', sourceSheet: 'S', sourceRow: 9, ticketNo: '999', date: '2024-12-02', amount: 1000 };
    const v = assessDuplicate(a, b);
    expect('evidence' in v && v.evidence).toBeTruthy();
  });
});

// ───────────────────────── idempotency key (§24) ────────────────────────────

describe('natural key', () => {
  const row = { sourceFile: 'S.xlsx', sourceSheet: 'Sales DEC-24', sourceRow: 12, ticketNo: '123', date: '2024-12-02', amount: 100.5 };

  it('is stable for the same source row', () => {
    expect(naturalKey(row)).toBe(naturalKey({ ...row }));
  });

  it('differs for a different row in the same sheet', () => {
    expect(naturalKey(row)).not.toBe(naturalKey({ ...row, sourceRow: 13 }));
  });

  it('fits the unique index it backs', () => {
    const long = { ...row, sourceFile: 'x'.repeat(300), sourceSheet: 'y'.repeat(300) };
    expect(naturalKey(long).length).toBeLessThanOrEqual(190);
  });
});

// ────────────────── the rules file and the code agree ───────────────────────

describe('historicalRules.ts matches database/import/party_aliases.json', () => {
  const json = JSON.parse(readFileSync(
    resolve(__dirname, '../../database/import/party_aliases.json'), 'utf8'));

  const withoutComment = (o: Record<string, unknown>) => {
    const { _comment, ...rest } = o;
    return rest;
  };

  it.each([
    ['customer_aliases', CUSTOMER_ALIASES],
    ['agent_aliases', AGENT_ALIASES],
    ['known_suppliers', KNOWN_SUPPLIERS],
    ['known_customers', KNOWN_CUSTOMERS],
  ])('%s is identical in both', (key, code) => {
    // The extraction script reads the JSON and the application reads the TS.
    // If they ever disagree, the migration classifies rows one way and the
    // party master another — so they are compared rather than trusted.
    expect(withoutComment(json[key])).toEqual(code);
  });
});
