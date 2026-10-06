import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

/**
 * The service talks to MySQL; the unit suite must not. Mocking the db module
 * lets the real service logic run — normalisation, the duplicate check, the
 * LIKE parameters it builds — while the queries themselves are observed rather
 * than executed.
 */
vi.mock('../src/config/db', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  pool: { end: vi.fn() },
}));

import { app } from '../src/app';
import { crmService, nameKey } from '../src/modules/crm/crm.service';
import { query, withTransaction } from '../src/config/db';
import { ROLE } from '../src/constants/roles';
import { authHeader } from './helpers/token';

const mockQuery = vi.mocked(query);
const mockTx = vi.mocked(withTransaction);

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue([] as never);
});

// ───────────────────────────── normalisation ────────────────────────────────

describe('nameKey — how two names are judged the same', () => {
  it.each([
    ['SUN PHARMA', 'sun pharma'],
    ['SUN PHARMA', 'Sun Pharma'],
    ['SUN PHARMA', '  Sun   Pharma  '],
    ['SUN PHARMA', 'SUN\tPHARMA'],
  ])('%s === %s', (a, b) => {
    expect(nameKey(a)).toBe(nameKey(b));
  });

  it('leaves spelling alone — that call belongs to a human', () => {
    // The client ruled these two are the SAME party and that ECO SORCHING is a
    // DIFFERENT one. No normaliser can tell those apart, so it must not try.
    expect(nameKey('GROUPO SORCHING')).not.toBe(nameKey('GROUPO SORCING'));
    expect(nameKey('GROUPO SORCHING')).not.toBe(nameKey('ECO SORCHING'));
  });

  it('agrees with the generated column the database compares on', () => {
    // migration 008: UPPER(TRIM(REGEXP_REPLACE(name,'[[:space:]]+',' ')))
    expect(nameKey(' eco   sorching ')).toBe('ECO SORCHING');
  });
});

// ─────────────────────────── duplicate prevention ───────────────────────────

describe('duplicate prevention', () => {
  it('refuses a customer whose name differs only by case or spacing', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 7, name: 'SUN PHARMA' }] as never);

    await expect(
      crmService.createCustomer(1, { name: '  sun   pharma ', creditLimit: 0 }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Refused before the transaction opens — no ledger is created for a party
    // that is not going to exist.
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('names the existing record so the user knows what to pick instead', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 7, name: 'SUN PHARMA' }] as never);
    await expect(crmService.createCustomer(1, { name: 'Sun Pharma', creditLimit: 0 }))
      .rejects.toThrow(/SUN PHARMA.*#7/);
  });

  it('refuses a duplicate supplier the same way', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 3, name: 'HAZEE' }] as never);
    await expect(crmService.createSupplier(1, { name: 'hazee' }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(mockTx).not.toHaveBeenCalled();
  });

  it('lets a genuinely new name through', async () => {
    mockQuery.mockResolvedValueOnce([] as never);        // nothing on file
    mockTx.mockResolvedValueOnce(42 as never);

    await expect(crmService.createCustomer(1, { name: 'GROUPO SORCHING', creditLimit: 0 }))
      .resolves.toBe(42);
    expect(mockTx).toHaveBeenCalledOnce();
  });

  it('compares on the normalised key, not the raw name', async () => {
    await crmService.findCustomerByName(1, '  Sun   Pharma ');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('name_key = ?'), [1, 'SUN PHARMA']);
  });
});

// ────────────────────────────────── search ──────────────────────────────────

describe('party search', () => {
  it('matches a partial term anywhere in the name', async () => {
    await crmService.searchCustomers(1, 'pharma');
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toContain('%pharma%');
  });

  it('ranks prefix hits above infix hits', async () => {
    await crmService.searchCustomers(1, 'sun');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/ORDER BY CASE WHEN name LIKE/);
    expect(params).toContain('sun%');
  });

  it('searches the phone as well as the name', async () => {
    await crmService.searchCustomers(1, '01712');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/phone LIKE/);
  });

  it('caps the page even when a bigger limit is asked for', async () => {
    await crmService.searchCustomers(1, 'a', 5000);
    expect(mockQuery.mock.calls[0][1]).toContain(50);
  });

  it('defaults to a page of 25', async () => {
    await crmService.searchCustomers(1, 'a');
    expect(mockQuery.mock.calls[0][1]).toContain(25);
  });

  it('treats % and _ as characters to find, not wildcards to run', async () => {
    // Without escaping, a stray "%" would match every party on file.
    await crmService.searchCustomers(1, '100%');
    expect(mockQuery.mock.calls[0][1]).toContain('%100\\%%');
  });

  it('returns the first page rather than nothing when the box is empty', async () => {
    await crmService.searchCustomers(1, '');
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).not.toMatch(/LIKE/);
    expect(sql).toMatch(/ORDER BY name/);
  });

  it('never aggregates voucher entries — that is the list endpoint’s job', async () => {
    // The picker fires per keystroke. If this query ever grows a JOIN onto
    // voucher_entries, typing a customer's name starts scanning the ledger.
    await crmService.searchCustomers(1, 'sun');
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/voucher_entries|SUM\(/);
  });

  it('scopes every search to the caller’s company', async () => {
    await crmService.searchSuppliers(9, 'hazee');
    expect(mockQuery.mock.calls[0][1]?.[0]).toBe(9);
  });
});

// ─────────────────────────────── HTTP surface ───────────────────────────────

describe('GET /api/crm/customers/search', () => {
  it('is reachable — the :id route does not swallow "search"', async () => {
    const res = await request(app)
      .get('/api/crm/customers/search?q=sun')
      .set(authHeader(ROLE.SALES));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects a limit above the ceiling instead of honouring it', async () => {
    const res = await request(app)
      .get('/api/crm/customers/search?q=a&limit=5000')
      .set(authHeader(ROLE.SALES));
    expect(res.status).toBe(400);
  });

  it('needs a session', async () => {
    const res = await request(app).get('/api/crm/customers/search?q=sun');
    expect(res.status).toBe(401);
  });
});

// ──────────────────────────────── quick add ─────────────────────────────────

describe('quick add', () => {
  it('lets Sales create a customer mid-booking', async () => {
    mockQuery.mockResolvedValue([] as never);
    mockTx.mockResolvedValue(51 as never);

    const res = await request(app)
      .post('/api/crm/customers')
      .set(authHeader(ROLE.SALES))
      .send({ name: 'NEW TRAVEL CO' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe(51);
  });

  it('does not let Sales create a vendor', async () => {
    const res = await request(app)
      .post('/api/crm/suppliers')
      .set(authHeader(ROLE.SALES))
      .send({ name: 'NEW CONSOLIDATOR' });
    expect(res.status).toBe(403);
  });

  it('surfaces the duplicate as a 409 the modal can show', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 7, name: 'SUN PHARMA' }] as never);

    const res = await request(app)
      .post('/api/crm/customers')
      .set(authHeader(ROLE.ACCOUNTANT))
      .send({ name: 'sun pharma' });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already exists/i);
  });
});
