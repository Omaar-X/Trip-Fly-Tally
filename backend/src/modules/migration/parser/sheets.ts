import {
  RawCell, cellAmount, cellDate, cellText, classifyRow, columnIndex, columnMap,
  findHeader, headerKeyOf, norm,
} from './primitives';
import { NormalizedRow, RowOutcome, SourceRef, rawOf } from './types';
import {
  LEDGER, classifyAgencyToken, classifyClientToken, classifyReferenceToken, classifyService,
} from '../historicalRules';

/**
 * ======================= THE THREE SOURCE SHAPES ============================
 *
 * The books changed format twice in fifteen months, so there are three parsers
 * rather than one clever one:
 *
 *   PARTY LEDGER    Mar–May 2024. Date · Ticket · Pax · Route · Debit · Credit
 *                   · Due Balance, running down one customer's account.
 *   SALES REGISTER  Jun 2024 onward. 26–30 columns per ticket, with client,
 *                   issuing agency, reference, fare breakdown and profit.
 *   DAY BOOK        Receipts on the left, payments on the right, on the SAME
 *                   row. One spreadsheet row can be two transactions.
 *
 * A single parser with flags for all three would have been shorter and much
 * harder to be sure about. Each of these reads one shape and says so.
 *
 * Common to all three: rows are classified before they are read, every row
 * produces exactly one outcome, and the raw cells always travel with it.
 */

const BOUNDS = { min: '2024-03-01', max: '2025-06-30' };

/**
 * The party ledgers name the account a receipt landed in — in the Route cell,
 * of all places: "CASH", "DBBL BANK", "City bank", "BRAC".
 *
 * Only banks the sources actually name appear here. An unrecognised word is
 * left unmatched so the row goes to review rather than being assigned a bank
 * that a reconciliation would then fail against.
 */
const BANK_WORDS: [RegExp, string][] = [
  [/dbbl/i, 'DBBL Bank'],
  [/city\s*bank/i, 'City Bank — A/C 110245'],
  [/brac/i, 'BRAC Bank'],
  [/sbac/i, 'SBAC Bank'],
  [/ucb/i, 'UCB Bank'],
];

function moneyFromText(text: string): { method: 'CASH' | 'BANK' | null; bankLedger: string | null } {
  if (/^\s*cash\s*$/i.test(text)) return { method: 'CASH', bankLedger: null };
  for (const [re, ledger] of BANK_WORDS)
    if (re.test(text)) return { method: 'BANK', bankLedger: ledger };
  // A bare "BANK" says which side without saying which account.
  if (/bank/i.test(text)) return { method: 'BANK', bankLedger: null };
  return { method: null, bankLedger: null };
}

const nonTransaction = (
  source: SourceRef, rowKind: NormalizedRow['rowKind'],
  header: RawCell[], cells: RawCell[], reason: string,
): NormalizedRow => ({
  outcome: 'NON_TRANSACTION', rowKind, source, raw: rawOf(header, cells), reason,
});

const review = (
  source: SourceRef, header: RawCell[], cells: RawCell[],
  reviewCategory: NormalizedRow['reviewCategory'], reason: string,
  extra: Partial<NormalizedRow> = {},
): NormalizedRow => ({
  outcome: 'REVIEW_REQUIRED', rowKind: 'DATA', source,
  raw: rawOf(header, cells), reviewCategory, reason, ...extra,
});

// ═══════════════════════════ 1 · party ledger ═══════════════════════════════

/**
 * Mar–May 2024: one customer's running account.
 *
 * `Debit` is a sale to that customer, `Credit` is money received. `Due Balance`
 * is the running total and is NOT a transaction — reading it as one would
 * triple-count the month.
 *
 * Continuation rows are real: a booking for four passengers puts the amount on
 * the first row and the other three names underneath with empty money columns.
 * They are kept as passengers of the row above rather than discarded, because
 * discarding them loses who actually travelled.
 */
export function parsePartyLedger(
  sheetRows: { rowNumber: number; cells: RawCell[] }[],
  source: Omit<SourceRef, 'row'>,
  partyName: string,
): NormalizedRow[] {
  const out: NormalizedRow[] = [];
  const head = findHeader(sheetRows.map((r) => r.cells), [['DATE'], ['DEBIT'], ['CREDIT']]);
  if (!head) {
    return [review({ ...source, row: 0 }, [], [], 'UNPARSEABLE_ROW',
      `No Date/Debit/Credit header found in "${source.sheet}".`)];
  }

  const header = head.cells;
  const key = headerKeyOf(header);
  const map = columnMap(header);
  const cDate = columnIndex(map, 'DATE');
  const cTicket = columnIndex(map, 'TICKET NO.', 'TICKET NO', 'TICKET NUMBER');
  const cPax = columnIndex(map, 'PAX NAME', 'NAME');
  const cRoute = columnIndex(map, 'RUTE', 'ROUTE', 'ROUTING');
  const cDebit = columnIndex(map, 'DEBIT');
  const cCredit = columnIndex(map, 'CREDIT');

  let lastDate: string | null = null;
  let lastTicket: string | null = null;

  for (const { rowNumber, cells } of sheetRows) {
    const ref: SourceRef = { ...source, row: rowNumber };
    if (rowNumber <= head.index + 1) {
      out.push(nonTransaction(ref, rowNumber === head.index + 1 ? 'HEADER' : 'TITLE',
        header, cells, rowNumber === head.index + 1 ? 'Column header row.' : 'Sheet title.'));
      continue;
    }

    const kind = classifyRow(cells, { headerKey: key });
    if (kind !== 'DATA') {
      out.push(nonTransaction(ref, kind, header, cells, {
        BLANK: 'Blank spacer row.',
        TITLE: 'Title or section heading.',
        SUBTOTAL: 'Total / balance row — a summary, never a transaction.',
        NOTE: 'Note or signature line.',
        REPEATED_HEADER: 'The column header repeated mid-sheet.',
        HEADER: 'Column header row.',
        DATA: '',
      }[kind]));
      continue;
    }

    // An EMPTY date cell continues the day above — normal in these ledgers.
    // A date cell with content that does not parse is a different thing: the
    // March sheet has "21.0324", a dd.mm.yy typed with one dot missing.
    // Carrying the previous date forward would silently file it on the wrong
    // day, so it goes to review with the raw value visible.
    const dateCellText = cDate >= 0 ? cellText(cells[cDate]) : '';
    const parsedDate = cDate >= 0 ? cellDate(cells[cDate], BOUNDS) : null;
    const dateUnreadable = dateCellText !== '' && parsedDate == null;
    // "21.0324" parses, but only because a missing dot was normalised. The row
    // posts — losing a real transaction over a typo would be worse — and a
    // review note records the reading so a person confirms it.
    const dateNormalised = /^\d{1,2}\.\d{4}$/.test(dateCellText);
    const date: string | null = parsedDate ?? (dateCellText === '' ? lastDate : null);
    if (date) lastDate = date;

    const debit = cDebit >= 0 ? cellAmount(cells[cDebit]) : null;
    const credit = cCredit >= 0 ? cellAmount(cells[cCredit]) : null;
    const ticketText = cTicket >= 0 ? cellText(cells[cTicket]) : '';
    // "Amount Received" sits in the ticket column on receipt rows. It is a
    // marker, not a ticket number, and treating it as one made every receipt in
    // the month look like a duplicate of every other.
    const isReceiptMarker = /^amount\s+received$/i.test(ticketText);
    const ticket = isReceiptMarker ? '' : ticketText;
    const pax = cPax >= 0 ? cellText(cells[cPax]) : '';
    const route = cRoute >= 0 ? cellText(cells[cRoute]) : '';
    const raw = rawOf(header, cells);

    // A continuation row: another passenger on the booking above.
    if (debit == null && credit == null) {
      if (!pax) {
        out.push(nonTransaction(ref, 'NOTE', header, cells,
          'No amount and no passenger — carries only a running balance.'));
      } else {
        out.push({
          outcome: 'NON_TRANSACTION', rowKind: 'DATA', source: ref, raw,
          reason: `Additional passenger on ticket ${lastTicket ?? '(previous row)'} — no separate amount in the source.`,
          passenger: pax, ticketNo: lastTicket, date,
        });
      }
      continue;
    }

    if (dateUnreadable) {
      out.push(review(ref, header, cells, 'UNPARSEABLE_ROW',
        `Date cell reads "${dateCellText}", which is not a date this parser will guess at.`));
      continue;
    }
    if (!date) {
      out.push(review(ref, header, cells, 'UNPARSEABLE_ROW',
        'Row carries an amount but no usable date.'));
      continue;
    }

    if (ticket) lastTicket = ticket;

    // ── 4 · what the Route column says the row actually is ──────────────────
    // These ledgers use the Route cell to label non-sale events: "Refund
    // Adjust", "Voied Charge", "DATE CHANGE FEE". Reading every Debit as a
    // sale would book a void penalty as revenue.
    // The label sits in the Route cell on some rows and the Ticket cell on
    // others — "REFUND" appears in both across Mar-May 2024 — so both are read.
    const label = `${route} ${ticketText}`;
    const isRefund = /refund/i.test(label);
    const isVoid = /vo(i|ie)d/i.test(label);

    if (isVoid && debit != null) {
      out.push({
        outcome: 'FINANCIAL', kind: 'PENALTY', rowKind: 'DATA', source: ref, raw, date,
        customerText: partyName, customer: partyName,
        ticketNo: ticket || null, passenger: pax || null, route,
        costAmount: debit,
        expenseCategorySource: route,
        expenseLedger: LEDGER.VOID,
        narration: [pax, route].filter(Boolean).join(' · '),
      });
      continue;
    }

    if (isRefund && credit != null) {
      out.push({
        outcome: 'FINANCIAL', kind: 'RECEIPT', rowKind: 'DATA', source: ref, raw, date,
        customerText: partyName, customer: partyName,
        ticketNo: ticket || null, passenger: pax || null, route,
        receivedAmount: credit,
        // A refund adjustment settles the account without money moving, so the
        // method is deliberately unstated rather than assumed to be cash.
        method: null,
        remarks: 'Refund adjustment against the customer account',
        narration: [pax, route].filter(Boolean).join(' · '),
      });
      continue;
    }

    const isReceipt = credit != null && credit > 0;
    if (isReceipt) {
      // These ledgers record the account in the Route cell: "CASH", "DBBL
      // BANK", "City bank". Anything unrecognised stays unstated so the row
      // goes to review rather than being posted to a guessed account.
      const money = moneyFromText(route);
      out.push({
        outcome: 'FINANCIAL', kind: 'RECEIPT', rowKind: 'DATA', source: ref, raw, date,
        customerText: partyName, customer: partyName,
        receivedAmount: credit,
        method: money.method, bankLedger: money.bankLedger,
        narration: [ticket, pax, route].filter(Boolean).join(' · ') || 'Amount received',
        ticketNo: ticket || null, remarks: pax || null,
      });
      continue;
    }

    out.push({
      outcome: 'FINANCIAL', kind: 'SALE', rowKind: 'DATA', source: ref, raw, date,
      customerText: partyName, customer: partyName,
      ticketNo: ticket || null, passenger: pax || null, route: route || null,
      sellingAmount: debit,
      serviceCategory: classifyService(null, [route, ticket].filter(Boolean).join(' ')),
      narration: [pax, route].filter(Boolean).join(' · ') || 'Ticket sale',
      ...(dateNormalised ? {
        reviewCategory: 'OTHER' as const,
        reason: `Source date "${dateCellText}" was read as ${date} (a missing dot). Confirm the reading.`,
      } : {}),
    });
  }
  return out;
}

// ═══════════════════════════ 2 · sales register ═════════════════════════════

/**
 * Jun 2024 onward: the 26–30 column register.
 *
 * The columns drift in spelling across the months (`CLAINT NAME`, `issueing
 * Agency` with one space or two, `REFFERENCE`), so every lookup lists the
 * spellings actually seen rather than assuming one.
 *
 * `OFFICE PAYMENT` is what the client pays and is the reliable selling figure.
 * `QUTATION FARE` is NOT read: Phase 1 established it is a stale fill-down.
 */
export function parseSalesRegister(
  sheetRows: { rowNumber: number; cells: RawCell[] }[],
  source: Omit<SourceRef, 'row'>,
): NormalizedRow[] {
  const out: NormalizedRow[] = [];
  const head = findHeader(sheetRows.map((r) => r.cells),
    [['NAME'], ['DATE', 'TICKET NUMBER']]);
  if (!head) {
    return [review({ ...source, row: 0 }, [], [], 'UNPARSEABLE_ROW',
      `No sales header found in "${source.sheet}".`)];
  }

  const header = head.cells;
  const key = headerKeyOf(header);
  const map = columnMap(header);
  const c = {
    date: columnIndex(map, 'DATE'),
    pax: columnIndex(map, 'NAME'),
    ticket: columnIndex(map, 'TICKET NUMBER', 'TICKET NO.', 'TICKET NO'),
    route: columnIndex(map, 'ROUTING', 'RUTE', 'ROUTE'),
    airline: columnIndex(map, 'AIRLINES', 'AIRLINE'),
    base: columnIndex(map, 'BASE FARE'),
    tax: columnIndex(map, 'TAX'),
    total: columnIndex(map, 'TOTAL FARE'),
    ait: columnIndex(map, 'AIT'),
    com: columnIndex(map, 'COM'),
    airlinePay: columnIndex(map, 'AIRLINES PAYMENT', 'AIRLINE PAYMENT'),
    service: columnIndex(map, 'SERVICE'),
    office: columnIndex(map, 'OFFICE PAYMENT'),
    profit: columnIndex(map, 'OFFICE PROFIT'),
    agency: columnIndex(map, 'ISSUEING AGENCY', 'ISSUING AGENCY'),
    reference: columnIndex(map, 'REFFERENCE', 'REFERENCE'),
    client: columnIndex(map, 'CLAINT NAME', 'CLIENT NAME'),
    pnr: columnIndex(map, 'PNR'),
  };

  for (const { rowNumber, cells } of sheetRows) {
    const ref: SourceRef = { ...source, row: rowNumber };
    if (rowNumber <= head.index) {
      out.push(nonTransaction(ref, rowNumber === head.index ? 'HEADER' : 'TITLE',
        header, cells, rowNumber === head.index ? 'Column header row.' : 'Sheet title.'));
      continue;
    }

    const kind = classifyRow(cells, { headerKey: key });
    if (kind !== 'DATA') {
      out.push(nonTransaction(ref, kind, header, cells, {
        BLANK: 'Blank spacer row.', TITLE: 'Title or section heading.',
        SUBTOTAL: 'Total row — a summary, never a transaction.',
        NOTE: 'Note or signature line.',
        REPEATED_HEADER: 'The column header repeated mid-sheet.',
        HEADER: 'Column header row.', DATA: '',
      }[kind]));
      continue;
    }

    const raw = rawOf(header, cells);
    const date = c.date >= 0 ? cellDate(cells[c.date], BOUNDS) : null;
    const selling = c.office >= 0 ? cellAmount(cells[c.office]) : null;
    const cost = c.airlinePay >= 0 ? cellAmount(cells[c.airlinePay])
      : (c.total >= 0 ? cellAmount(cells[c.total]) : null);
    const clientText = c.client >= 0 ? cellText(cells[c.client]) : '';
    const agencyText = c.agency >= 0 ? cellText(cells[c.agency]) : '';
    const refText = c.reference >= 0 ? cellText(cells[c.reference]) : '';
    const pax = c.pax >= 0 ? cellText(cells[c.pax]) : '';
    const ticket = c.ticket >= 0 ? cellText(cells[c.ticket]) : '';
    const route = c.route >= 0 ? cellText(cells[c.route]) : '';

    if (!date && selling == null && cost == null) {
      out.push(nonTransaction(ref, 'NOTE', header, cells,
        'No date and no amount — not a transaction row.'));
      continue;
    }
    if (!date) {
      out.push(review(ref, header, cells, 'UNPARSEABLE_ROW',
        'Row carries an amount but no date inside the migration window.'));
      continue;
    }

    const client = classifyClientToken(clientText);
    const agency = agencyText ? classifyAgencyToken(agencyText) : null;
    const agent = refText ? classifyReferenceToken(refText) : null;

    const common: Partial<NormalizedRow> = {
      date,
      customerText: clientText || null,
      vendorText: agencyText || null,
      agentText: refText || null,
      agent: agent?.name ?? null,
      ticketNo: ticket || null,
      pnr: c.pnr >= 0 ? cellText(cells[c.pnr]) || null : null,
      passenger: pax || null,
      route: route || null,
      airline: c.airline >= 0 ? cellText(cells[c.airline]) || null : null,
      sellingAmount: selling,
      costAmount: cost,
      serviceCharge: c.service >= 0 ? cellAmount(cells[c.service]) : null,
      profitSource: c.profit >= 0 ? cellAmount(cells[c.profit]) : null,
      taxAit: c.ait >= 0 ? cellAmount(cells[c.ait]) : null,
      commission: c.com >= 0 ? cellAmount(cells[c.com]) : null,
      serviceCategory: classifyService(null, [route, pax, ticket].filter(Boolean).join(' ')),
      narration: [pax, route].filter(Boolean).join(' · ') || 'Ticket sale',
    };

    // ADM / VOID — a company loss, not a party. Preserved, never discarded.
    if (client.type === 'GL' && client.treatment === 'AIRLINE_PENALTY') {
      out.push({
        outcome: 'FINANCIAL', kind: 'PENALTY', rowKind: 'DATA', source: ref, raw,
        ...common,
        customer: null,
        expenseCategorySource: clientText,
        expenseLedger: client.ledger,
        vendor: agency?.type === 'SUPPLIER' ? agency.name : null,
      });
      continue;
    }

    if (client.type === 'REVIEW_REQUIRED') {
      out.push(review(ref, header, cells, 'AMBIGUOUS_PARTY_MATCH',
        client.reason ?? `Client "${clientText}" could not be classified.`, common));
      continue;
    }

    if (agency && agency.type === 'REVIEW_REQUIRED') {
      out.push(review(ref, header, cells, 'MISSING_VENDOR',
        agency.reason ?? `Issuing agency "${agencyText}" is not a known vendor.`,
        { ...common, customer: client.name }));
      continue;
    }

    out.push({
      outcome: 'FINANCIAL', kind: 'SALE', rowKind: 'DATA', source: ref, raw,
      ...common,
      customer: client.type === 'CUSTOMER' ? client.name : null,
      vendor: agency?.type === 'SUPPLIER' ? agency.name : null,
    });
  }
  return out;
}

// ═══════════════════════════ 3 · day book ═══════════════════════════════════

/**
 * Receipts on the left, payments on the right, on the same physical row.
 *
 * One spreadsheet row therefore produces up to TWO transactions, and each gets
 * its own normalized row with the same source reference. The row number is
 * shared on purpose: both halves genuinely came from that line of that sheet,
 * and the natural key distinguishes them by side.
 *
 * "OPENING CASH & BANK" is a stated balance, not a movement.
 */
export function parseDayBook(
  sheetRows: { rowNumber: number; cells: RawCell[] }[],
  source: Omit<SourceRef, 'row'>,
): NormalizedRow[] {
  const out: NormalizedRow[] = [];
  const head = findHeader(sheetRows.map((r) => r.cells),
    [['CASH REC', 'CASH RECEIVED'], ['BANK REC', 'BANK RECEIVED']]);
  if (!head) {
    return [review({ ...source, row: 0 }, [], [], 'UNPARSEABLE_ROW',
      `No day-book header found in "${source.sheet}".`)];
  }

  const header = head.cells;
  const key = headerKeyOf(header);
  // The two halves repeat the same column names, so indexes are taken
  // positionally from the header itself rather than by name lookup.
  const idx = header.map((h) => norm(h));
  const receiptSide = {
    date: idx.indexOf('DATE'),
    name: idx.indexOf('NAME'),
    desc: idx.indexOf('DESCRIPTION'),
    cash: idx.indexOf('CASH REC'),
    bank: idx.indexOf('BANK REC'),
  };
  const paymentSide = {
    date: idx.lastIndexOf('DATE'),
    name: idx.lastIndexOf('NAME'),
    desc: Math.max(idx.lastIndexOf('DISCRIPTION'), idx.lastIndexOf('DESCRIPTION')),
    cash: idx.indexOf('CASH PAY'),
    bank: idx.indexOf('BANK PAY'),
  };

  for (const { rowNumber, cells } of sheetRows) {
    const ref: SourceRef = { ...source, row: rowNumber };
    if (rowNumber <= head.index + 1) {
      out.push(nonTransaction(ref, 'HEADER', header, cells, 'Header or title row.'));
      continue;
    }

    const kind = classifyRow(cells, { headerKey: key });
    if (kind !== 'DATA') {
      out.push(nonTransaction(ref, kind, header, cells, {
        BLANK: 'Blank spacer row.', TITLE: 'Title or section heading.',
        SUBTOTAL: 'Total row — a summary, never a transaction.',
        NOTE: 'Note line.', REPEATED_HEADER: 'The header repeated for a new day.',
        HEADER: 'Column header row.', DATA: '',
      }[kind]));
      continue;
    }

    const raw = rawOf(header, cells);
    let produced = 0;

    for (const [side, cols, txn] of [
      ['RECEIPT', receiptSide, 'RECEIPT'],
      ['PAYMENT', paymentSide, 'PAYMENT'],
    ] as const) {
      const cash = cols.cash >= 0 ? cellAmount(cells[cols.cash]) : null;
      const bank = cols.bank >= 0 ? cellAmount(cells[cols.bank]) : null;
      if (cash == null && bank == null) continue;
      if ((cash ?? 0) === 0 && (bank ?? 0) === 0) continue;

      const name = cols.name >= 0 ? cellText(cells[cols.name]) : '';
      const desc = cols.desc >= 0 ? cellText(cells[cols.desc]) : '';
      const date = cols.date >= 0 ? cellDate(cells[cols.date], BOUNDS) : null;
      const amount = (cash ?? 0) !== 0 ? cash! : bank!;
      const method: 'CASH' | 'BANK' = (cash ?? 0) !== 0 ? 'CASH' : 'BANK';

      // A stated opening position is not a movement.
      if (/OPENING/i.test(name)) {
        out.push({
          outcome: 'NON_TRANSACTION', rowKind: 'DATA', source: ref, raw,
          kind: 'OPENING', date, method, receivedAmount: amount,
          reason: `Stated opening ${method.toLowerCase()} balance — a position, not a transaction.`,
          narration: name,
        });
        produced++;
        continue;
      }

      if (!date) {
        out.push(review(ref, header, cells, 'UNPARSEABLE_ROW',
          `${side} side carries ${amount} but no usable date.`,
          { narration: [name, desc].filter(Boolean).join(' · ') }));
        produced++;
        continue;
      }

      // The name in a day book is a party like any other and goes through the
      // same classification: PDC is a customer, ADM and VOID are penalties, and
      // an ambiguous name is parked rather than guessed. Without this the day
      // book produced receipts with no party and every one failed to post.
      //
      // Vendors are checked FIRST. `classifyClientToken` reads an unrecognised
      // name as a customer under its own name, which is right for the client
      // column of a sales register and wrong here: "HAZEE" in a day book is the
      // consolidator being paid, and reading it as a customer would open a
      // receivable against the company's largest supplier.
      const asVendor = name ? classifyAgencyToken(name) : null;
      const party = !name ? null
        : asVendor?.type === 'SUPPLIER' ? asVendor
          : classifyClientToken(name);

      if (party?.type === 'REVIEW_REQUIRED') {
        out.push(review(ref, header, cells, 'AMBIGUOUS_PARTY_MATCH',
          party.reason ?? `Day-book party "${name}" could not be classified.`,
          { date, method, narration: [name, desc].filter(Boolean).join(' · ') }));
        produced++;
        continue;
      }

      out.push({
        outcome: 'FINANCIAL',
        // A day-book line naming ADM or VOID is a penalty, not a plain payment.
        kind: party?.type === 'GL' && party.treatment === 'AIRLINE_PENALTY' ? 'PENALTY' : txn,
        rowKind: 'DATA', source: ref,
        // Each half keeps the whole row, plus which side it came from, so the
        // two are told apart in the trail without losing their shared origin.
        raw: { ...raw, __side: side },
        date, method,
        customerText: name || null,
        customer: party?.type === 'CUSTOMER' ? party.name : null,
        vendor: party?.type === 'SUPPLIER' ? party.name : null,
        expenseCategorySource: party?.type === 'GL' ? name : null,
        expenseLedger: party?.ledger ?? null,
        narration: [name, desc].filter(Boolean).join(' · ') || side,
        receivedAmount: txn === 'RECEIPT' ? amount : null,
        sellingAmount: null,
        costAmount: txn === 'PAYMENT' ? amount : null,
        remarks: desc || null,
      });
      produced++;
    }

    if (produced === 0) {
      out.push(nonTransaction(ref, 'NOTE', header, cells,
        'Numbered row with no amount on either side.'));
    }
  }
  return out;
}
