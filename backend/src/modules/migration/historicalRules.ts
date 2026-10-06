/**
 * ================== WHAT EACH HISTORICAL TOKEN ACTUALLY IS ==================
 *
 * The spreadsheets name a party in a free-text cell. Deciding what that text
 * means — a customer, the vendor, the CEO acting as an introducer, or an
 * airline penalty that is not a party at all — is the single most consequential
 * step of the migration, so it lives in one pure module that can be tested
 * without a database.
 *
 * Two rules govern everything below, both from the client:
 *
 *   1. Never fuzzy-merge. Similar names are not evidence. "ECO SORCHING" and
 *      "GROUPO SOURCING" are one letter apart in places and are two different
 *      companies; "GROUPO SORCING" and "GROUPO SOURCING" are the same one.
 *      Only the explicit alias table decides, and it was written by a human.
 *
 *   2. Never silently discard a financial row. A token nobody can classify
 *      becomes REVIEW_REQUIRED and goes to the queue — it does not vanish.
 *
 * The alias table mirrors database/import/party_aliases.json, which the
 * extraction script reads. historicalRules.test.ts asserts the two agree, so
 * neither copy can drift from the other.
 * ===========================================================================
 */

/** How a name is compared: case and stray spacing out, spelling untouched. */
export const normalizeToken = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toUpperCase();

export type PartyType =
  | 'CUSTOMER' | 'SUPPLIER' | 'AGENT' | 'EMPLOYEE'
  | 'BANK' | 'LOAN' | 'GL' | 'NONE' | 'REVIEW_REQUIRED';

export type ServiceCategory =
  | 'AIR_TICKET' | 'VISA' | 'TOUR' | 'HOTEL' | 'HAJJ_UMRAH' | 'OTHER' | 'REVIEW_REQUIRED';

export interface Classification {
  type: PartyType;
  /** Canonical name to store, or null when the token names no party. */
  name: string | null;
  /**
   * Where the value goes when it is not a party — an expense treatment for a
   * penalty, for instance. Never a reason to drop the row.
   */
  treatment?: 'AIRLINE_PENALTY';
  /** The exact ledger the row posts to, when the treatment names one. */
  ledger?: string;
  serviceCategory?: ServiceCategory;
  /** Filled whenever type is REVIEW_REQUIRED, so the queue row explains itself. */
  reason?: string;
}

/**
 * The ledgers created by migration 011.
 *
 * ADM and VOID share a parent and a nature and are still two ledgers: "what
 * did ADMs cost us" and "what did voids cost us" are different questions, and
 * one merged ledger answers neither without going back to the source rows.
 *
 * Names are ASCII on purpose — they are matched by string against the ledgers
 * table, and a client charset that mangles an em-dash would break the lookup
 * silently. That happened on the staging run before these were plain hyphens.
 */
export const LEDGER = {
  ADM: 'ADM - Airline Debit Memo',
  VOID: 'VOID - Ticket Void Charge',
  CEO_DRAWINGS: 'CEO Drawings',
} as const;

// ─────────────────────────── the alias tables ───────────────────────────────

/**
 * Spelling variants of one customer. Phase 3 changed the GROUPO canonical from
 * "GROUPO SORCHING" to "GROUPO SOURCING"; the older spelling is now itself an
 * alias, which is why it appears on the left.
 */
export const CUSTOMER_ALIASES: Readonly<Record<string, string>> = {
  'ECO SORCING': 'ECO SORCHING',
  'ECO SOURCING': 'ECO SORCHING',
  'GROUPO SORCING': 'GROUPO SOURCING',
  'GROUPO SORCHING': 'GROUPO SOURCING',
  'GROUP SORCHING': 'GROUPO SOURCING',
  'RAZIB SIR PERSONAL': 'RAJIB SIR PERSONAL',
  'RAZIB SIR HAJJ': 'RAJIB SIR HAJJ',
};

/**
 * The REFFERENCE column names who the booking came through. RAJIB and RAZIB
 * are one person — the CEO — and 718 rows carry him. Mapping that to a
 * customer would have opened a receivable against the company's own director.
 */
export const AGENT_ALIASES: Readonly<Record<string, string>> = {
  'RAJIB SIR': 'RAJIB SIR',
  'RAZIB SIR': 'RAJIB SIR',
  'WASIM BHAI': 'WASHIM BHAI',
  'WASHIM': 'WASHIM BHAI',
  'WAS': 'WASHIM BHAI',
  'TUTUL': 'TUTUL BHAI',
  'TUTUL(RASHEEL)': 'TUTUL BHAI',
  'TUTUL BHAI (RASHEEL)': 'TUTUL BHAI',
};

export const KNOWN_SUPPLIERS: Readonly<Record<string, string>> = {
  'HAZEE': 'HAZEE',
  'HAJEE': 'HAZEE',
  'TRV. CHAMP': 'TRAVEL CHAMP',
  'TRAVEL CHAMP': 'TRAVEL CHAMP',
  'SKY HOLIDAYS': 'SKY HOLIDAYS',
  'WORLD HOLID': 'WORLD HOLIDAYS',
  'BIMAN BANGLA': 'BIMAN BANGLADESH AIRLINES',
};

/** Confirmed customers whose earlier classification was wrong. */
export const KNOWN_CUSTOMERS: Readonly<Record<string, string>> = {
  // Phase 2 read PDC as "post-dated cheque" and excluded it. It is an Air Force
  // department — a real organisation whose sales must migrate normally.
  'PDC': 'PDC (AIR FORCE)',
};

/**
 * Company loss, not a counterparty. ADM is an airline debit memo — a penalty
 * charged back to the agency — and VOID is a cancellation charge of the same
 * nature. Both were being dropped before Phase 3; both are real money.
 *
 * They map to two ledgers under one parent, not to one shared ledger, so the
 * two costs stay separately reportable.
 */
export const EXPENSE_TOKENS: Readonly<Record<string, { treatment: 'AIRLINE_PENALTY'; ledger: string }>> = {
  'ADM': { treatment: 'AIRLINE_PENALTY', ledger: LEDGER.ADM },
  'VOID': { treatment: 'AIRLINE_PENALTY', ledger: LEDGER.VOID },
};

/** Product or route labels. The row still migrates; only the party link is absent. */
export const NON_PARTY_TOKENS: Readonly<Record<string, ServiceCategory>> = {
  'PHILIPINE TICKET': 'AIR_TICKET',
  'JAPAN TKT-1': 'AIR_TICKET',
  'JAPAN GARDEN': 'REVIEW_REQUIRED',
  'SRILANKA GROUP TOUR': 'TOUR',
  '0': 'REVIEW_REQUIRED',
};

export const EMPLOYEES: readonly string[] = [
  'MS TAHMINA BASHAR', 'MD SHAMSUDDIN RAZIB', 'MR ABHIJIT DEY',
  'MR NAZMUL HASAN', 'MR SABBIR HOSSAIN', 'MR SAZZAD',
];

export const BANKS: readonly string[] = ['BRAC', 'SBAC', 'UCB'];

export const LOAN_PARTIES: Readonly<Record<string, string>> = {
  'MADAME': 'TAHMINA BASHAR (PROPRIETOR)',
  'ABHIJIT': 'ABHIJIT DEY',
  'ECO-FUAD': 'FUAD (ECO)',
};

/**
 * Tokens parked on purpose. Each is a real ambiguity someone has to settle —
 * an abbreviation, an unnamed third party, two names in one cell — and
 * guessing at any of them would put money on the wrong ledger.
 */
export const REVIEW_TOKENS: Readonly<Record<string, string>> = {
  'RAJIB SIR': 'In the client column this is ambiguous: the CEO as a buyer, or a mis-keyed reference?',
  'RAZIB SIR': 'Same ambiguity as RAJIB SIR in the client column.',
  'RAZIB SIR PER': 'Abbreviation — probably RAJIB SIR PERSONAL, but an abbreviation is not evidence.',
  'RAJIB SIR UNCLE': "A relative's ticket; own account or the CEO's?",
  'RAZIB SIR BROTHERS': 'Same question as RAJIB SIR UNCLE.',
  'RAJIB SIR CLAIENT': 'Unnamed third party introduced by the CEO.',
  'RAJIB SIR CLIENT': 'Same as RAJIB SIR CLAIENT (spelling), still unnamed.',
  'RAJIB SIR FRIEND': 'Unnamed third party.',
  'RAZIB SIR FRIEND': 'Unnamed third party.',
  'ECO MAHFUZ/ RAZIB SIR': 'Two names in one cell.',
  'ECO SORCING PERSONAL': 'A personal sub-account of ECO, or a separate party?',
  'SUN PERSONAL': 'A personal sub-account of SUN PHARMA, or a separate party?',
  'SUN PHARMA PER': 'Abbreviation of SUN PERSONAL?',
};

// ───────────────────────────── classification ───────────────────────────────

/**
 * What a value in the CLIENT column means.
 *
 * Order matters: the explicit review list is consulted before the alias table,
 * so a token someone deliberately parked cannot be quietly resolved by a
 * spelling rule added later.
 */
export function classifyClientToken(raw: string): Classification {
  const token = normalizeToken(raw);
  if (!token) return { type: 'NONE', name: null };

  if (token in REVIEW_TOKENS)
    return { type: 'REVIEW_REQUIRED', name: null, reason: REVIEW_TOKENS[token] };

  if (token in EXPENSE_TOKENS) {
    const { treatment, ledger } = EXPENSE_TOKENS[token];
    return { type: 'GL', name: token, treatment, ledger };
  }

  if (token in NON_PARTY_TOKENS) {
    const category = NON_PARTY_TOKENS[token];
    return category === 'REVIEW_REQUIRED'
      ? { type: 'REVIEW_REQUIRED', name: null, reason: `"${token}" names no identifiable party or service.` }
      : { type: 'NONE', name: null, serviceCategory: category };
  }

  if (token in KNOWN_CUSTOMERS)
    return { type: 'CUSTOMER', name: KNOWN_CUSTOMERS[token] };

  if (EMPLOYEES.includes(token))
    return { type: 'EMPLOYEE', name: token };

  if (token in CUSTOMER_ALIASES)
    return { type: 'CUSTOMER', name: CUSTOMER_ALIASES[token] };

  // Anything else is taken at face value as a customer under its own name.
  // That is not a guess — it is the absence of one: no merging, no reshaping,
  // the party is exactly what the source called it.
  return { type: 'CUSTOMER', name: token };
}

/** What a value in the `issueing Agency` column means. */
export function classifyAgencyToken(raw: string): Classification {
  const token = normalizeToken(raw);
  if (!token) return { type: 'NONE', name: null };

  if (token in KNOWN_SUPPLIERS)
    return { type: 'SUPPLIER', name: KNOWN_SUPPLIERS[token] };

  // An unrecognised vendor is parked rather than created: the agency column is
  // a short, closed list in this dataset, so a new value is more likely a typo
  // or a placeholder than a new consolidator.
  return {
    type: 'REVIEW_REQUIRED', name: null,
    reason: `"${token}" is not a known issuing agency. Confirm before creating a vendor.`,
  };
}

/**
 * What a value in the REFFERENCE column means.
 *
 * Always an agent, never a debt. A reference alone also never creates
 * commission — that requires an explicit amount in the source, which is
 * `commissionFromSource` below.
 */
export function classifyReferenceToken(raw: string): Classification {
  const token = normalizeToken(raw);
  if (!token || token === '0') return { type: 'NONE', name: null };
  return { type: 'AGENT', name: AGENT_ALIASES[token] ?? token };
}

/**
 * Commission is created only where the source states an amount.
 *
 * A name in the reference column means the booking came through that person.
 * It does not mean they are owed anything, and inventing a payable from a
 * reference would fabricate a liability across 718 rows.
 */
export function commissionFromSource(
  amount: number | null | undefined,
): { create: false } | { create: true; amount: number } {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return { create: false };
  return { create: true, amount };
}

// ──────────────────────────── owner drawings ────────────────────────────────

/**
 * Wording in the historical sources that plainly states a withdrawal by the
 * owner. Every one of these appears in the day books or the month-end sheets:
 * "WITHDRAWN FROM RAZIB SIR", "RAZIB SIR WITHDRAWN", "RAJIB SIR PERSONAL
 * (CARD PAYMENT)", "MADAME EXPENSES".
 *
 * Matching on the *transaction's own description*, never on the party name —
 * which is the whole point of the rule below.
 */
const DRAWING_EVIDENCE: readonly RegExp[] = [
  /\bwithdraw(n|al)?\b/i,
  /\bdrawings?\b/i,
  // The day books write this as "RAJIB SIR PERSONAL ( CARD PAYMENT )", so the
  // gap between the words is punctuation as often as it is a space.
  /\bpersonal\b[^a-z]{0,4}(card[^a-z]{0,4})?(payment|expense|withdraw)/i,
  /\bown(er)?'?s?\s+(withdraw|drawing)/i,
];

export type DrawingVerdict =
  | { drawings: true; ledger: string; evidence: string }
  | { drawings: false; review: true; reason: string }
  | { drawings: false; review: false };

/**
 * Whether a row should post to CEO Drawings.
 *
 * The trap this exists to avoid: `RAJIB SIR PERSONAL` and `RAJIB SIR HAJJ` are
 * the CEO's own accounts, so it is tempting to route everything on them
 * straight to Drawings. The client ruled explicitly against that — **follow the
 * historical source treatment first**. A personal-account ticket that the
 * source shows as a normal sale on credit is a receivable, not a withdrawal,
 * and turning it into one would move real money off the debtors ledger.
 *
 * So Drawings requires evidence in the row itself:
 *
 *   · the source says withdrawal/drawing → Drawings
 *   · the source gives a clear non-drawing treatment (a sale, a receipt) →
 *     follow that, and this function stays out of the way
 *   · a CEO-personal party with nothing to go on → REVIEW_REQUIRED
 *   · anyone else with nothing to go on → not a drawing, nothing to review
 */
export function assessDrawings(
  partyName: string | null | undefined,
  description: string | null | undefined,
  sourceTreatment?: string | null,
): DrawingVerdict {
  const text = `${description ?? ''} ${sourceTreatment ?? ''}`.trim();

  const hit = DRAWING_EVIDENCE.find((re) => re.test(text));
  if (hit) return { drawings: true, ledger: LEDGER.CEO_DRAWINGS, evidence: text };

  // The source stated a treatment and it is not a withdrawal. Honour it.
  if (sourceTreatment?.trim()) return { drawings: false, review: false };

  const party = normalizeToken(partyName ?? '');
  const CEO_PERSONAL = ['RAJIB SIR PERSONAL', 'RAJIB SIR HAJJ'];
  if (CEO_PERSONAL.includes(party))
    return {
      drawings: false, review: true,
      reason: `"${party}" is a CEO personal account, but the source does not say whether this row is a `
        + 'drawing or an ordinary sale. Owner-withdrawal treatment must not be assumed.',
    };

  return { drawings: false, review: false };
}

// ───────────────────────────── service category ─────────────────────────────

const CATEGORY_PATTERNS: ReadonlyArray<[RegExp, ServiceCategory]> = [
  [/\bhajj?\b|\bumrah\b/i, 'HAJJ_UMRAH'],
  [/\bvisa\b/i, 'VISA'],
  [/\bhotel\b|\broom\b/i, 'HOTEL'],
  [/\btour\b|\bland package\b|\bpackage\b/i, 'TOUR'],
  [/\bticket\b|\bair\b|\bpnr\b|\bfare\b/i, 'AIR_TICKET'],
];

/**
 * The source's own category wins whenever it has one. Description matching is
 * a fallback and only fires on wording that plainly names a service — anything
 * else is REVIEW_REQUIRED rather than a plausible-looking guess.
 */
export function classifyService(
  sourceCategory: string | null | undefined,
  description: string | null | undefined,
): ServiceCategory {
  const explicit = normalizeToken(sourceCategory ?? '');
  if (explicit) {
    const known: Record<string, ServiceCategory> = {
      'AIR TICKET': 'AIR_TICKET', 'AIR': 'AIR_TICKET', 'TICKET': 'AIR_TICKET',
      'VISA': 'VISA', 'HOTEL': 'HOTEL', 'TOUR': 'TOUR', 'LAND PACKAGE': 'TOUR',
      'HAJJ': 'HAJJ_UMRAH', 'UMRAH': 'HAJJ_UMRAH', 'OTHER': 'OTHER',
    };
    if (explicit in known) return known[explicit];
    // A category the source states but we do not recognise is preserved as a
    // question, not flattened into OTHER.
    return 'REVIEW_REQUIRED';
  }

  const text = (description ?? '').trim();
  if (!text) return 'REVIEW_REQUIRED';

  const hits = CATEGORY_PATTERNS.filter(([re]) => re.test(text)).map(([, c]) => c);

  // "Umrah package" matches both HAJJ_UMRAH and TOUR, and it is plainly the
  // former: Hajj and Umrah are a named kind of package, so the specific label
  // wins over the general one rather than the pair cancelling out.
  if (hits.includes('HAJJ_UMRAH')) return 'HAJJ_UMRAH';

  // Any other pair — "hotel and visa processing" — names two unrelated
  // services, which is exactly where guessing costs the most.
  return hits.length === 1 ? hits[0] : 'REVIEW_REQUIRED';
}

// ─────────────────────── duplicate transaction evidence ─────────────────────

export interface HistoricalRow {
  sourceFile: string;
  sourceSheet: string;
  sourceRow: number;
  ticketNo?: string | null;
  pnr?: string | null;
  date?: string | null;
  amount?: number | null;
  party?: string | null;
}

export type DuplicateVerdict =
  | { duplicate: true; evidence: string }
  | { duplicate: false; review: true; evidence: string }
  | { duplicate: false; review: false };

/**
 * Whether two historical rows are the same transaction seen twice.
 *
 * The client was explicit that "same date + same amount" is not enough, and
 * they are right: a consolidator issuing four identical tickets for one family
 * on one day produces four rows that look like one row repeated. So a ticket
 * number — the thing an airline guarantees unique — is what proves identity.
 *
 * Same ticket, different amount is not a duplicate either; it is a reissue, a
 * refund or a correction, and it goes to review rather than being collapsed.
 */
export function assessDuplicate(a: HistoricalRow, b: HistoricalRow): DuplicateVerdict {
  const sameFile = a.sourceFile === b.sourceFile && a.sourceSheet === b.sourceSheet;
  if (sameFile && a.sourceRow === b.sourceRow) return { duplicate: false, review: false };

  const ticketA = normalizeToken(a.ticketNo ?? '');
  const ticketB = normalizeToken(b.ticketNo ?? '');

  if (ticketA && ticketA === ticketB) {
    const sameAmount = a.amount != null && b.amount != null && Math.abs(a.amount - b.amount) < 0.005;
    const sameDate = a.date != null && a.date === b.date;

    if (sameAmount && sameDate)
      return { duplicate: true, evidence: `Ticket ${ticketA}, same date ${a.date} and amount ${a.amount}.` };

    return {
      duplicate: false, review: true,
      evidence: `Ticket ${ticketA} appears twice with ${
        sameAmount ? 'different dates' : 'different amounts'
      } — a reissue or correction, not a duplicate.`,
    };
  }

  // Two different ticket numbers settle it: these are two tickets, however
  // alike the rest of the row looks. This is the common case that the naive
  // date-plus-amount rule gets wrong — a family of four flying together on one
  // booking produces four rows identical in every column but the ticket.
  if (ticketA && ticketB && ticketA !== ticketB) return { duplicate: false, review: false };

  // No ticket number to go on. Date and amount alone never decide it.
  const sameAmount = a.amount != null && b.amount != null && Math.abs(a.amount - b.amount) < 0.005;
  const sameDate = a.date != null && a.date === b.date;
  const sameParty = normalizeToken(a.party ?? '') === normalizeToken(b.party ?? '') && !!a.party;

  if (sameAmount && sameDate && sameParty)
    return {
      duplicate: false, review: true,
      evidence: 'Same date, amount and party but no ticket number to confirm identity.',
    };

  return { duplicate: false, review: false };
}

/**
 * The idempotency key for a source row.
 *
 * Built from what identifies the row in its own source, so a re-run recognises
 * work it already did. Deliberately includes the source location: two genuinely
 * distinct rows that happen to share a ticket, date and amount still get
 * different keys, and the duplicate question is answered by `assessDuplicate`
 * with evidence rather than by silently colliding here.
 */
export function naturalKey(row: HistoricalRow): string {
  const parts = [
    row.sourceFile, row.sourceSheet, String(row.sourceRow),
    normalizeToken(row.ticketNo ?? ''), row.date ?? '',
    row.amount == null ? '' : row.amount.toFixed(2),
  ];
  return parts.join('|').slice(0, 190);
}
