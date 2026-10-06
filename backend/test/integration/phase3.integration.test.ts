import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

/**
 * ================ PHASE 3 AGAINST A REAL, MIGRATED DATABASE =================
 *
 * The unit suites mock `config/db`, so they prove the logic and prove nothing
 * about the DDL. This file is the other half: it runs the approval workflow,
 * BDR, soft delete/restore, the audit trail and a migration batch — including
 * a rollback — against a database that has actually had migrations 007–011
 * applied to it.
 *
 * Point it at a STAGING COPY, never production:
 *
 *     DB_NAME=tripfly_erp_staging npx vitest run --config vitest.integration.config.ts
 *
 * Skips itself when no database is reachable, so `npm test` still runs clean on
 * a machine without MySQL.
 * ============================================================================
 */

const { app, pool, reachable, migrated } = await (async () => {
  try {
    const [{ app }, { pool }] = await Promise.all([
      import('../../src/app'), import('../../src/config/db'),
    ]);
    const conn = await pool.getConnection();
    // Phase 3 tables must exist, or the file is pointed at the wrong database.
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name IN ('change_requests','backdated_access_requests','migration_batches','agents')`);
    conn.release();
    const n = Number((rows as { n: number }[])[0]?.n ?? 0);
    return { app, pool, reachable: true, migrated: n === 4 };
  } catch {
    return { app: null as never, pool: null as never, reachable: false, migrated: false };
  }
})();

const { tokenFor } = await import('../helpers/token');
const { ROLE } = await import('../../src/constants/roles');

const suite = reachable && migrated ? describe : describe.skip;

/** Created rows are cleaned up so the staging copy stays re-runnable. */
const created = { changeRequests: [] as number[], bdrs: [] as number[], batches: [] as number[], grants: [] as number[] };

const ceo = () => ({ Authorization: `Bearer ${tokenFor(ROLE.CEO, { sub: 1 })}` });
const accountant = () => ({ Authorization: `Bearer ${tokenFor(ROLE.ACCOUNTANT, { sub: 1 })}` });
const admin = (id = 1) => ({ Authorization: `Bearer ${tokenFor(ROLE.ADMIN, { sub: id })}` });

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

suite('Phase 3 · against a real migrated database', () => {
  beforeAll(async () => {
    // Everything runs as user 1 (the seeded CEO) except where a second actor is
    // needed; self-approval is blocked, so those cases use a second user.
    await pool.query(
      `INSERT IGNORE INTO users (id, company_id, role_id, name, email, password_hash, approval_status)
       VALUES (900, 1, 3, 'Integration Accountant', 'integration.accountant@example.test', '$2a$10$x', 'APPROVED'),
              (901, 1, 2, 'Integration Admin', 'integration.admin@example.test', '$2a$10$x', 'APPROVED')`);
  });

  afterAll(async () => {
    for (const id of created.changeRequests) await pool.query('DELETE FROM change_requests WHERE id = ?', [id]);
    for (const id of created.bdrs) await pool.query('DELETE FROM backdated_access_requests WHERE id = ?', [id]);
    for (const id of created.batches) await pool.query('DELETE FROM migration_batches WHERE id = ?', [id]);
    for (const id of created.grants) await pool.query('DELETE FROM admin_approval_grants WHERE id = ?', [id]);
    await pool.query('DELETE FROM users WHERE id IN (900, 901)');
    await pool.end();
  });

  // ───────────────────────── the 011 ledgers exist ────────────────────────────

  it('has the CEO Drawings ledger under Equity', async () => {
    const [rows] = await pool.query(
      `SELECT l.name, g.name AS grp, g.nature, p.name AS parent
         FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id
         LEFT JOIN ledger_groups p ON p.id = g.parent_id
        WHERE l.name = 'CEO Drawings'`);
    expect((rows as unknown[]).length).toBe(1);
    expect((rows as { grp: string; nature: string; parent: string }[])[0])
      .toMatchObject({ grp: 'Owner / CEO Drawings', nature: 'EQUITY', parent: 'Capital Account' });
  });

  it('has ADM and VOID as two ledgers under one penalty group', async () => {
    const [rows] = await pool.query(
      `SELECT l.name FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id
        WHERE g.name = 'Airline Penalty & Loss' ORDER BY l.name`);
    expect((rows as { name: string }[]).map((r) => r.name))
      .toEqual(['ADM - Airline Debit Memo', 'VOID - Ticket Void Charge']);
  });

  // ────────────────────────── party dedup (008) ───────────────────────────────

  it('refuses a duplicate customer name differing only by case', async () => {
    const name = `Integration Dedup ${Date.now()}`;
    const first = await request(app).post('/api/crm/customers').set(ceo()).send({ name });
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/crm/customers').set(ceo())
      .send({ name: name.toUpperCase() });
    expect(second.status).toBe(409);

    await pool.query('DELETE FROM customers WHERE id = ?', [first.body.data.id]);
    await pool.query("DELETE FROM ledgers WHERE name LIKE ?", [`Customer — ${name}%`]);
  });

  // ──────────────────────── change-request workflow ───────────────────────────

  describe('edit request → CEO decision → one-time permission', () => {
    let requestId = 0;

    it('an Accountant raises it', async () => {
      const res = await request(app).post('/api/approvals/change-requests')
        .set({ Authorization: `Bearer ${tokenFor(ROLE.ACCOUNTANT, { sub: 900 })}` })
        .send({
          kind: 'EDIT', entity: 'vouchers', entityId: 12345,
          reason: 'Integration test — wrong ledger picked on entry.',
          proposedValues: { narration: 'corrected' }, priority: 'URGENT',
        });
      expect(res.status).toBe(201);
      expect(res.body.data.requestNo).toMatch(/^EDT-\d{4}-\d{5}$/);
      requestId = res.body.data.id;
      created.changeRequests.push(requestId);
    });

    it('stores version 1 of what was proposed', async () => {
      const [rows] = await pool.query(
        'SELECT version, proposed_values FROM change_request_versions WHERE request_id = ?', [requestId]);
      expect((rows as unknown[]).length).toBe(1);
    });

    it('refuses an Admin recommendation without the CEO grant', async () => {
      const res = await request(app).post(`/api/approvals/change-requests/${requestId}/recommend`)
        .set(admin(901)).send({ recommendation: 'APPROVE' });
      expect(res.status).toBe(403);
    });

    it('accepts the recommendation once the CEO grants review authority', async () => {
      const grant = await request(app).post('/api/approvals/admin-grants').set(ceo())
        .send({ userId: 901, scope: 'CHANGE_REVIEW' });
      expect(grant.status).toBe(201);
      created.grants.push(grant.body.data.id);

      const res = await request(app).post(`/api/approvals/change-requests/${requestId}/recommend`)
        .set(admin(901)).send({ recommendation: 'APPROVE', note: 'Looks right.' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ADMIN_REVIEWED');
    });

    it('still refuses to let that Admin decide it', async () => {
      const res = await request(app).post(`/api/approvals/change-requests/${requestId}/decide`)
        .set(admin(901)).send({ action: 'APPROVE' });
      expect(res.status).toBe(403);
    });

    it('leaves the transaction untouched while the request is open', async () => {
      const [rows] = await pool.query('SELECT status FROM change_requests WHERE id = ?', [requestId]);
      expect((rows as { status: string }[])[0].status).toBe('ADMIN_REVIEWED');
      const [otp] = await pool.query('SELECT id FROM one_time_permissions WHERE request_id = ?', [requestId]);
      expect((otp as unknown[]).length).toBe(0);
    });

    it('the CEO approves, and exactly one permission is minted', async () => {
      const res = await request(app).post(`/api/approvals/change-requests/${requestId}/decide`)
        .set(ceo()).send({ action: 'APPROVE', note: 'Approved.' });
      expect(res.status).toBe(200);

      const [otp] = await pool.query(
        'SELECT user_id, kind, entity, entity_id, used_at FROM one_time_permissions WHERE request_id = ?',
        [requestId]);
      expect((otp as unknown[]).length).toBe(1);
      expect((otp as { user_id: number; kind: string; used_at: null }[])[0])
        .toMatchObject({ user_id: 900, kind: 'EDIT', used_at: null });
    });

    it('refuses a second decision on the same request', async () => {
      const res = await request(app).post(`/api/approvals/change-requests/${requestId}/decide`)
        .set(ceo()).send({ action: 'REJECT' });
      expect(res.status).toBe(403);
    });

    it('wrote an audit row for the decision', async () => {
      const [rows] = await pool.query(
        `SELECT action FROM audit_logs WHERE entity = 'change_requests' AND entity_id = ?
          ORDER BY id DESC LIMIT 5`, [requestId]);
      expect((rows as { action: string }[]).map((r) => r.action)).toContain('CHANGE_REQUEST_APPROVE');
    });
  });

  // ─────────────────────────────── BDR ────────────────────────────────────────

  describe('backdated access', () => {
    let bdrId = 0;

    it('an Accountant requests a window', async () => {
      const res = await request(app).post('/api/approvals/bdr')
        .set({ Authorization: `Bearer ${tokenFor(ROLE.ACCOUNTANT, { sub: 900 })}` })
        .send({ module: 'PAYMENT', from: daysAgo(20), to: daysAgo(5), reason: 'Integration test — catching up receipts.' });
      expect(res.status).toBe(201);
      expect(res.body.data.requestNo).toMatch(/^BDR-\d{4}-\d{5}$/);
      bdrId = res.body.data.id;
      created.bdrs.push(bdrId);
    });

    it('refuses a window wider than the one requested', async () => {
      const res = await request(app).post(`/api/approvals/bdr/${bdrId}/approve`)
        .set(ceo()).send({ from: daysAgo(60) });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not extend it earlier/i);
    });

    it('approves a narrowed window and stamps a 24-hour expiry', async () => {
      const res = await request(app).post(`/api/approvals/bdr/${bdrId}/approve`)
        .set(ceo()).send({ from: daysAgo(15), to: daysAgo(10), note: 'Narrowed.' });
      expect(res.status).toBe(200);

      const [rows] = await pool.query(
        'SELECT approved_from, approved_to, expires_at, status FROM backdated_access_requests WHERE id = ?',
        [bdrId]);
      const row = (rows as { approved_from: Date; expires_at: Date; status: string }[])[0];
      expect(row.status).toBe('APPROVED');
      const hours = (new Date(row.expires_at).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23);
      expect(hours).toBeLessThan(25);
    });

    it('requires a reason to revoke, then revokes', async () => {
      const bad = await request(app).post(`/api/approvals/bdr/${bdrId}/revoke`).set(ceo()).send({});
      expect(bad.status).toBe(400);

      const ok = await request(app).post(`/api/approvals/bdr/${bdrId}/revoke`)
        .set(ceo()).send({ reason: 'Integration test — no longer needed.' });
      expect(ok.status).toBe(200);

      const [rows] = await pool.query('SELECT status FROM backdated_access_requests WHERE id = ?', [bdrId]);
      expect((rows as { status: string }[])[0].status).toBe('REVOKED');
    });
  });

  // ─────────────────────── soft delete and restore ────────────────────────────

  describe('soft delete and restore', () => {
    let paymentId = 0;

    beforeAll(async () => {
      const [res] = await pool.query(
        `INSERT INTO payments (company_id, payment_no, direction, method, amount, payment_date, created_by)
         VALUES (1, ?, 'IN', 'CASH', 100.00, ?, 1)`,
        [`ITG-${Date.now()}`, today()]);
      paymentId = (res as { insertId: number }).insertId;
    });

    afterAll(async () => { await pool.query('DELETE FROM payments WHERE id = ?', [paymentId]); });

    it('marks the row deleted without removing it', async () => {
      await pool.query(
        'UPDATE payments SET deleted_at = NOW(), deleted_by = 1, delete_reason = ? WHERE id = ?',
        ['Integration test', paymentId]);
      const [rows] = await pool.query('SELECT id, deleted_at, delete_reason FROM payments WHERE id = ?', [paymentId]);
      expect((rows as unknown[]).length).toBe(1);
      expect((rows as { deleted_at: Date | null }[])[0].deleted_at).not.toBeNull();
    });

    it('lets the CEO restore it', async () => {
      const res = await request(app).post('/api/approvals/restore').set(ceo())
        .send({ entity: 'payments', entityId: paymentId });
      expect(res.status).toBe(200);

      const [rows] = await pool.query('SELECT deleted_at, restored_at, restored_by FROM payments WHERE id = ?', [paymentId]);
      const row = (rows as { deleted_at: null; restored_at: Date; restored_by: number }[])[0];
      expect(row.deleted_at).toBeNull();
      expect(row.restored_at).not.toBeNull();
      expect(row.restored_by).toBe(1);
    });

    it('refuses a restore from an Accountant', async () => {
      const res = await request(app).post('/api/approvals/restore').set(accountant())
        .send({ entity: 'payments', entityId: paymentId });
      expect(res.status).toBe(403);
    });
  });

  // ───────────────────── migration batch and rollback ─────────────────────────

  describe('migration batch, staging and rollback', () => {
    let batchId = 0;

    it('opens a batch with a snapshot reference', async () => {
      const res = await request(app).post('/api/migration/batches').set(ceo())
        .send({ period: '2024-03', description: 'Integration test', snapshotRef: 'backup_pre_migration.sql' });
      expect(res.status).toBe(201);
      expect(res.body.data.batchNo).toMatch(/^MIG-\d{4}-\d{5}$/);
      batchId = res.body.data.id;
      created.batches.push(batchId);
    });

    it('stages rows and rolls the whole batch back', async () => {
      // Two staged rows standing in for imported transactions, one of them
      // pointing at a real payment so the rollback has something to delete.
      const [pay] = await pool.query(
        `INSERT INTO payments (company_id, payment_no, direction, method, amount, payment_date, created_by)
         VALUES (1, ?, 'IN', 'CASH', 500.00, ?, 1)`,
        [`MIG-${Date.now()}`, today()]);
      const payId = (pay as { insertId: number }).insertId;

      await pool.query(
        `INSERT INTO migration_source_rows
           (company_id, batch_id, source_file, source_sheet, source_row, source_period,
            party_type, status, natural_key, target_entity, target_id)
         VALUES (1, ?, 'ITG.xlsx', 'Sheet1', 1, '2024-03', 'CUSTOMER', 'IMPORTED', ?, 'payments', ?)`,
        [batchId, `itg-${Date.now()}-a`, payId]);
      await pool.query(
        `INSERT INTO migration_source_rows
           (company_id, batch_id, source_file, source_sheet, source_row, source_period,
            party_type, status, natural_key)
         VALUES (1, ?, 'ITG.xlsx', 'Sheet1', 2, '2024-03', 'REVIEW_REQUIRED', 'REVIEW_REQUIRED', ?)`,
        [batchId, `itg-${Date.now()}-b`]);
      await pool.query(
        `INSERT INTO migration_review_items (company_id, batch_id, module, issue_type, issue)
         VALUES (1, ?, 'PARTY', 'AMBIGUOUS_PARTY', 'Integration test item')`, [batchId]);

      const res = await request(app).post(`/api/migration/batches/${batchId}/rollback`).set(ceo()).send({});
      expect(res.status).toBe(200);
      expect(res.body.data.removed).toBe(1);

      // Everything the batch touched is gone: the payment, both staged rows,
      // and the review item.
      const [left] = await pool.query('SELECT id FROM payments WHERE id = ?', [payId]);
      expect((left as unknown[]).length).toBe(0);
      const [rows] = await pool.query('SELECT id FROM migration_source_rows WHERE batch_id = ?', [batchId]);
      expect((rows as unknown[]).length).toBe(0);
      const [items] = await pool.query('SELECT id FROM migration_review_items WHERE batch_id = ?', [batchId]);
      expect((items as unknown[]).length).toBe(0);

      const [batch] = await pool.query('SELECT status, rollback_status FROM migration_batches WHERE id = ?', [batchId]);
      expect((batch as { status: string; rollback_status: string }[])[0])
        .toMatchObject({ status: 'ROLLED_BACK', rollback_status: 'DONE' });
    });

    it('refuses to roll back a verified month', async () => {
      const res2 = await request(app).post('/api/migration/batches').set(ceo())
        .send({ period: '2024-04', description: 'Verified-month guard' });
      const verifiedId = res2.body.data.id;
      created.batches.push(verifiedId);

      await pool.query("UPDATE migration_batches SET status = 'VERIFIED' WHERE id = ?", [verifiedId]);
      const res = await request(app).post(`/api/migration/batches/${verifiedId}/rollback`).set(ceo()).send({});
      expect(res.status).toBe(409);
    });
  });
});
