import { describe, it, expect } from 'vitest';
import {
  cellAmount, cellDate, cellNumber, cellText, classifyRow, columnIndex, columnMap,
  findHeader, hasAmountIn, headerKeyOf, norm,
} from '../src/modules/migration/parser/primitives';

/**
 * Every case here came out of the actual workbooks. The comments name where,
 * because a parser test that invents its inputs proves nothing about the files
 * it will be pointed at.
 */

// ────────────────────────────── text ────────────────────────────────────────

describe('cellText', () => {
  it('reads a plain string, trimmed', () => {
    expect(cellText('  SUN PHARMA  ')).toBe('SUN PHARMA');
  });

  it('reads the cached result of a formula, not the formula', () => {
    // The sales registers compute TOTAL FARE; the cached result is the number
    // the bookkeeper actually saw.
    expect(cellText({ formula: 'G3+H3', result: 64870 })).toBe('64870');
  });

  it('flattens rich text that was partly styled', () => {
    expect(cellText({ richText: [{ text: 'RAJIB ' }, { text: 'SIR' }] })).toBe('RAJIB SIR');
  });

  it('returns empty for a formula error rather than the error object', () => {
    expect(cellText({ error: '#REF!' })).toBe('');
  });

  it('returns empty for null and undefined', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
  });
});

describe('norm', () => {
  it('collapses case and spacing but never spelling', () => {
    expect(norm('  issueing   Agency ')).toBe('ISSUEING AGENCY');
    expect(norm('GROUPO SORCING')).not.toBe(norm('GROUPO SOURCING'));
  });
});

// ───────────────────────────── numbers ──────────────────────────────────────

describe('cellNumber', () => {
  it('reads a real number', () => {
    expect(cellNumber(64870)).toBe(64870);
  });

  it('reads an amount written with commas', () => {
    // "3,460,650.99" — the ACCOUNTS sheets store several of these as text.
    expect(cellNumber('3,460,650.99')).toBe(3460650.99);
  });

  it('reads a formula result', () => {
    expect(cellNumber({ formula: 'SUM(E4:E20)', result: 1234.5 })).toBe(1234.5);
  });

  it('reads an accountant negative in parentheses', () => {
    expect(cellNumber('(1,200)')).toBe(-1200);
  });

  it('strips a currency word', () => {
    expect(cellNumber('BDT 5,000')).toBe(5000);
    expect(cellNumber('TK. 250')).toBe(250);
  });

  it('refuses a ticket number written with a space', () => {
    // "157 6801435806" is a ticket, not 1,576,801,435,806. Getting this wrong
    // would post a ticket number as an amount.
    expect(cellNumber('157 6801435806')).toBeNull();
  });

  it('refuses a reference that merely contains digits', () => {
    expect(cellNumber('MR#021')).toBeNull();
    expect(cellNumber('VP240811399')).toBeNull();
    expect(cellNumber('DAC/KUL/DAC')).toBeNull();
  });

  it('refuses a placeholder', () => {
    for (const v of ['-', 'N/A', '', null, undefined]) expect(cellNumber(v)).toBeNull();
  });

  it('never reads a date as a number', () => {
    expect(cellNumber(new Date('2024-12-02'))).toBeNull();
  });

  it('rounds money to the paisa', () => {
    expect(cellAmount(133.3333)).toBe(133.33);
    expect(cellAmount('1,894,737.284')).toBe(1894737.28);
  });
});

// ────────────────────────────── dates ───────────────────────────────────────

describe('cellDate', () => {
  it('reads the dd.mm.yy the party ledgers use', () => {
    // "02.03.24" — Sales March, row 4.
    expect(cellDate('02.03.24')).toBe('2024-03-02');
  });

  it('reads a real Excel date', () => {
    expect(cellDate(new Date(Date.UTC(2024, 11, 2)))).toBe('2024-12-02');
  });

  it('reads dd/mm/yyyy', () => {
    expect(cellDate('2/3/2024')).toBe('2024-03-02');
  });

  it('reads an ISO string', () => {
    expect(cellDate('2025-06-01')).toBe('2025-06-01');
  });

  it('treats the day as first, as every one of these files does', () => {
    // 13.02.25 can only be 13 February — there is no month 13 to argue about,
    // and the same convention holds for 02.03.24.
    expect(cellDate('13.02.25')).toBe('2025-02-13');
  });

  it('refuses a date that does not exist rather than rolling it forward', () => {
    expect(cellDate('31.02.24')).toBeNull();
  });

  it('refuses anything outside the migration window when bounds are given', () => {
    const bounds = { min: '2024-03-01', max: '2025-06-30' };
    // 2027-07-14 sits in "January-19 to Till Now"; 2026-03-20 in RAW SHEET SALES.
    expect(cellDate('14.07.27', bounds)).toBeNull();
    expect(cellDate('20.03.26', bounds)).toBeNull();
    expect(cellDate('02.03.24', bounds)).toBe('2024-03-02');
  });

  it('returns null for text that is not a date', () => {
    expect(cellDate('Amount Received')).toBeNull();
    expect(cellDate('')).toBeNull();
  });
});

// ──────────────────────── row classification ────────────────────────────────

describe('classifyRow', () => {
  it('calls an empty row blank', () => {
    expect(classifyRow([null, '', undefined])).toBe('BLANK');
  });

  it('calls a total row a subtotal, even though it holds a number', () => {
    // This is the one that double-counts a month if it is got wrong.
    expect(classifyRow(['', 'TOTAL', '', 228000])).toBe('SUBTOTAL');
    expect(classifyRow(['', 'GRAND TOTAL', 19002055.55])).toBe('SUBTOTAL');
    expect(classifyRow(['', 'NET PROFIT', '', 3491.96])).toBe('SUBTOTAL');
    expect(classifyRow(['', 'NET LOSS', '', 285643.5])).toBe('SUBTOTAL');
  });

  it('calls a bank statement carry-forward a subtotal', () => {
    expect(classifyRow(['', 'Balance Forward', 0, 0, 33363.3])).toBe('SUBTOTAL');
  });

  it('recognises the header repeating mid-sheet', () => {
    const header = ['S.N', 'Date', 'Name', 'Description', 'Cash Rec', 'Bank Rec'];
    const key = headerKeyOf(header);
    // The day books restart this block for every new day.
    expect(classifyRow(header, { headerKey: key })).toBe('REPEATED_HEADER');
  });

  it('calls a title row a title', () => {
    expect(classifyRow(['', 'TRIP FLY BD'])).toBe('TITLE');
    expect(classifyRow(['', 'FOR THE MONTH OF DECEMBER 2024'])).toBe('TITLE');
    expect(classifyRow(['Daily Expenses (CASH)'])).toBe('TITLE');
  });

  it('calls a signature line a note', () => {
    expect(classifyRow(['', 'PREPARED BY', '', 'CHECKED BY'])).toBe('NOTE');
    expect(classifyRow(['', 'IN WORD- FIFTY SIX THOUSAND'])).toBe('NOTE');
  });

  it('calls a real transaction row data', () => {
    expect(classifyRow(['02.03.24', '157 6801435806', 'MS NUSRAT PARVIN SONY', 'MED-DOH-DAC', 20791, '', 20791]))
      .toBe('DATA');
  });

  it('calls a row with a name and no amount data, not a title', () => {
    // Continuation rows — extra passengers under one PNR — carry a name only,
    // and they are real rows the parser must see.
    expect(classifyRow(['', '', 'MAHIN/MD AFTAB UDDIN MR', '', '', '', 519492])).toBe('DATA');
  });
});

describe('hasAmountIn', () => {
  it('is true only when a money column holds a number', () => {
    const row = ['02.03.24', '157 6801435806', 'PAX', 'MED-DOH', 20791, '', 20791];
    expect(hasAmountIn(row, [4, 5])).toBe(true);
    expect(hasAmountIn(['', '', 'PAX', '', '', '', ''], [4, 5])).toBe(false);
  });
});

// ─────────────────────── header location and mapping ────────────────────────

describe('findHeader', () => {
  const rows = [
    [null],
    ['', 'MR RAZIB SIR (HAQUE GROUP)'],
    ['Date', 'Ticket No.', 'Pax Name', 'Rute', 'Debit', 'Credit', 'Due Balance'],
    ['02.03.24', '157 6801435806', 'MS NUSRAT', 'MED-DOH', 20791, '', 20791],
  ];

  it('finds the header wherever it sits', () => {
    const found = findHeader(rows, [['DATE'], ['DEBIT'], ['CREDIT']]);
    expect(found?.index).toBe(2);
  });

  it('accepts any of the spellings a column has been given', () => {
    const salesRows = [['SL. NO', 'NAME', 'DATE', 'TICKET NUMBER', 'CLAINT NAME']];
    const found = findHeader(salesRows, [['DATE'], ['CLAINT NAME', 'CLIENT NAME']]);
    expect(found?.index).toBe(0);
  });

  it('returns null rather than guessing when no header matches', () => {
    expect(findHeader([['a', 'b'], ['c', 'd']], [['DATE'], ['DEBIT']])).toBeNull();
  });
});

describe('columnMap and columnIndex', () => {
  const map = columnMap(['SL. NO', 'NAME', 'DATE', 'issueing  Agency', 'REFFERENCE', 'CLAINT NAME']);

  it('maps a column name to its index', () => {
    expect(columnIndex(map, 'DATE')).toBe(2);
  });

  it('collapses the double space in "issueing  Agency"', () => {
    expect(columnIndex(map, 'ISSUEING AGENCY')).toBe(3);
  });

  it('accepts either spelling of a drifting column name', () => {
    expect(columnIndex(map, 'CLIENT NAME', 'CLAINT NAME')).toBe(5);
    expect(columnIndex(map, 'REFERENCE', 'REFFERENCE')).toBe(4);
  });

  it('returns -1 for a column the sheet does not have', () => {
    expect(columnIndex(map, 'PNR')).toBe(-1);
  });
});
