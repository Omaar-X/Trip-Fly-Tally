import { query, exec, withTransaction, Row, WriteResult } from '../../config/db';
import { ApiError } from '../../utils/ApiError';
import { nextRequestNo } from '../../utils/numbering';
import { ROLE, RoleName } from '../../constants/roles';
import { notificationsService } from './notifications.service';
import {
  Actor, ChangeAction, ChangeKind, ChangeRequestState, Priority,
  canRequestChange, canUseGrant, deleteEffect, notifyImmediately,
  requestPrefix, transition,
} from './changeRequest.policy';
import {
  BdrActor, BdrModule, BdrRequest, VALIDITY_HOURS,
  approveRange, canApproveBdr, canCancel, canRequestBdr, canRevoke,
  coversTransaction, validateRequest,
} from './bdr.policy';

/**
 * ===================== THE APPROVAL WORKFLOW, WIRED UP ======================
 *
 * The policy modules decide; this one persists, notifies and enforces. Keeping
 * the decisions in pure functions next door is what lets the rules be tested
 * without a database and read without wading through SQL.
 *
 * One thing worth pointing at: nothing in here applies a proposed change to a
 * transaction. Approval mints a one-time permission, and the requester then
 * makes the edit through the module's own service, under its own posting
 * rules. An approval path that wrote to `vouchers` directly would be a second
 * way into the books that bypasses every check the first one does.
 * ===========================================================================
 */

const asDate = (v: unknown): Date | null => (v ? new Date(v as string) : null);

const toState = (r: Row): ChangeRequestState => ({
  id: Number(r.id),
  kind: r.kind as ChangeKind,
  status: r.status as ChangeRequestState['status'],
  requestedBy: Number(r.requested_by),
  isFinancial: Boolean(r.is_financial),
  version: Number(r.version),
});

const toBdr = (r: Row): BdrRequest => ({
  id: Number(r.id),
  module: r.module as BdrModule,
  requestedFrom: String(r.requested_from).slice(0, 10),
  requestedTo: String(r.requested_to).slice(0, 10),
  approvedFrom: r.approved_from ? String(r.approved_from).slice(0, 10) : null,
  approvedTo: r.approved_to ? String(r.approved_to).slice(0, 10) : null,
  status: r.status as BdrRequest['status'],
  requestedBy: Number(r.requested_by),
  expiresAt: asDate(r.expires_at),
});

/** Whether the CEO has granted this user a review/approval authority. */
async function hasGrant(companyId: number, userId: number, scope: 'CHANGE_REVIEW' | 'BDR_APPROVE') {
  const rows = await query<Row[]>(
    `SELECT id FROM admin_approval_grants
      WHERE company_id = ? AND user_id = ? AND scope = ? AND revoked_at IS NULL LIMIT 1`,
    [companyId, userId, scope]);
  return rows.length > 0;
}

export async function loadActor(companyId: number, user: { id: number; role: RoleName }): Promise<Actor & BdrActor> {
  const [review, bdr] = await Promise.all([
    hasGrant(companyId, user.id, 'CHANGE_REVIEW'),
    hasGrant(companyId, user.id, 'BDR_APPROVE'),
  ]);
  return { id: user.id, role: user.role, canReviewAsAdmin: review, canApproveBdr: bdr };
}

export const approvalsService = {

  // ═══════════════════════════ change requests ══════════════════════════════

  async createChangeRequest(companyId: number, actor: Actor, input: {
    kind: ChangeKind; entity: string; entityId: number; isFinancial?: boolean;
    reason: string; description?: string; priority?: Priority;
    originalValues?: unknown; proposedValues?: unknown;
  }) {
    if (!canRequestChange(actor))
      throw ApiError.forbidden('Your role cannot raise edit or delete requests.');
    if (!input.reason?.trim())
      throw ApiError.badRequest('A reason is required.');
    if (input.kind === 'EDIT' && input.proposedValues == null)
      throw ApiError.badRequest('An edit request must say what it proposes to change.');

    const created = await withTransaction(async (conn) => {
      const requestNo = await nextRequestNo(conn, companyId, requestPrefix(input.kind));
      const [res] = await conn.query<WriteResult>(
        `INSERT INTO change_requests
           (company_id, request_no, kind, entity, entity_id, is_financial, reason, description,
            priority, original_values, proposed_values, requested_by, requested_role)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [companyId, requestNo, input.kind, input.entity, input.entityId,
         input.isFinancial === false ? 0 : 1, input.reason.trim(), input.description ?? null,
         input.priority ?? 'NORMAL',
         input.originalValues ? JSON.stringify(input.originalValues) : null,
         input.proposedValues ? JSON.stringify(input.proposedValues) : null,
         actor.id, actor.role]);

      await conn.query(
        `INSERT INTO change_request_versions (request_id, version, proposed_values, reason, submitted_by)
         VALUES (?,1,?,?,?)`,
        [res.insertId, input.proposedValues ? JSON.stringify(input.proposedValues) : null,
         input.reason.trim(), actor.id]);

      return { id: res.insertId, requestNo };
    });

    await this.notifyApprovers(companyId, 'CHANGE_REQUEST_CREATED', created.id,
      `${created.requestNo} — ${input.kind.toLowerCase()} request`,
      `${input.entity} #${input.entityId}\nReason: ${input.reason.trim()}`,
      notifyImmediately(input.priority ?? 'NORMAL'));

    return created;
  },

  async getChangeRequest(companyId: number, id: number) {
    const rows = await query<Row[]>(
      'SELECT * FROM change_requests WHERE company_id = ? AND id = ?', [companyId, id]);
    if (!rows[0]) throw ApiError.notFound('Request not found.');
    return rows[0];
  },

  listChangeRequests: (companyId: number, filter: { status?: string; kind?: string; mine?: number }) => {
    const where = ['company_id = ?'];
    const params: unknown[] = [companyId];
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
    if (filter.mine) { where.push('requested_by = ?'); params.push(filter.mine); }
    return query<Row[]>(
      `SELECT * FROM change_requests WHERE ${where.join(' AND ')}
        ORDER BY FIELD(priority,'URGENT','HIGH','NORMAL','LOW'), id DESC LIMIT 200`, params);
  },

  /**
   * An Admin's opinion, recorded as an opinion.
   *
   * It moves the request to ADMIN_REVIEWED and nothing else. The CEO may
   * approve against it, or never look at it — Admin review is not a gate.
   */
  async recommend(companyId: number, actor: Actor, id: number, input: {
    recommendation: 'APPROVE' | 'REJECT' | 'NEEDS_CORRECTION'; note?: string;
  }) {
    const row = await this.getChangeRequest(companyId, id);
    const result = transition(toState(row), 'RECOMMEND', actor);
    if (!result.ok) throw ApiError.forbidden(result.error!);

    await exec(
      `UPDATE change_requests
          SET status = ?, admin_recommendation = ?, admin_reviewed_by = ?,
              admin_reviewed_at = NOW(), admin_note = ?
        WHERE id = ?`,
      [result.status, input.recommendation, actor.id, input.note ?? null, id]);
    return { status: result.status, recommendation: input.recommendation };
  },

  /**
   * The CEO's decision.
   *
   * Approving an EDIT does not change the transaction — it mints a one-time
   * permission the requester then spends. Approving a DELETE soft-deletes,
   * because a delete has no second step to perform.
   */
  async decide(companyId: number, actor: Actor, id: number, action: ChangeAction, input: {
    note?: string;
  } = {}) {
    const row = await this.getChangeRequest(companyId, id);
    const state = toState(row);
    const result = transition(state, action, actor);
    if (!result.ok) throw ApiError.forbidden(result.error!);

    if (action === 'NEEDS_CORRECTION' && !input.note?.trim())
      throw ApiError.badRequest('Say what needs correcting — a bare "needs correction" is not actionable.');

    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE change_requests
            SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ?
          WHERE id = ?`,
        [result.status, actor.id, input.note ?? null, id]);

      if (input.note?.trim())
        await conn.query(
          `INSERT INTO change_request_comments (request_id, author_id, author_role, body, moved_status)
           VALUES (?,?,?,?,?)`,
          [id, actor.id, actor.role, input.note.trim(), result.status]);

      if (result.status === 'APPROVED') {
        // One grant per request — re-approving cannot mint a second use.
        await conn.query(
          `INSERT IGNORE INTO one_time_permissions
             (company_id, request_id, user_id, kind, entity, entity_id, granted_by, granted_at)
           VALUES (?,?,?,?,?,?,?,NOW())`,
          [companyId, id, state.requestedBy, state.kind, row.entity, row.entity_id, actor.id]);
      }
    });

    await this.notifyRequester(companyId, state.requestedBy, 'CHANGE_REQUEST_DECIDED', id,
      `${row.request_no} — ${result.status!.toLowerCase()}`,
      input.note?.trim() ?? '');

    return { status: result.status };
  },

  /** Correct and resubmit the SAME request, keeping the thread in one place. */
  async resubmit(companyId: number, actor: Actor, id: number, input: {
    proposedValues?: unknown; reason: string;
  }) {
    const row = await this.getChangeRequest(companyId, id);
    const state = toState(row);
    const result = transition(state, 'RESUBMIT', actor);
    if (!result.ok) throw ApiError.forbidden(result.error!);
    if (!input.reason?.trim()) throw ApiError.badRequest('A reason is required on resubmission.');

    const version = state.version + 1;
    await withTransaction(async (conn) => {
      await conn.query(
        `UPDATE change_requests
            SET status = ?, version = ?, proposed_values = ?, reason = ?,
                decided_by = NULL, decided_at = NULL, decision_note = NULL,
                admin_recommendation = NULL, admin_reviewed_by = NULL, admin_reviewed_at = NULL
          WHERE id = ?`,
        [result.status, version,
         input.proposedValues ? JSON.stringify(input.proposedValues) : row.proposed_values,
         input.reason.trim(), id]);
      await conn.query(
        `INSERT INTO change_request_versions (request_id, version, proposed_values, reason, submitted_by)
         VALUES (?,?,?,?,?)`,
        [id, version, input.proposedValues ? JSON.stringify(input.proposedValues) : null,
         input.reason.trim(), actor.id]);
    });

    await this.notifyApprovers(companyId, 'CHANGE_REQUEST_RESUBMITTED', id,
      `${row.request_no} — resubmitted (v${version})`, input.reason.trim(), false);
    return { status: result.status, version };
  },

  async cancel(companyId: number, actor: Actor, id: number, reason: string) {
    if (!reason?.trim()) throw ApiError.badRequest('A cancel reason is required.');
    const row = await this.getChangeRequest(companyId, id);
    const result = transition(toState(row), 'CANCEL', actor);
    if (!result.ok) throw ApiError.forbidden(result.error!);

    await exec(
      "UPDATE change_requests SET status = 'CANCELLED', cancel_reason = ?, cancelled_at = NOW() WHERE id = ?",
      [reason.trim(), id]);
    return { status: 'CANCELLED' as const };
  },

  async addComment(companyId: number, actor: Actor, id: number, body: string) {
    if (!body?.trim()) throw ApiError.badRequest('An empty comment says nothing.');
    await this.getChangeRequest(companyId, id);
    const res = await exec(
      'INSERT INTO change_request_comments (request_id, author_id, author_role, body) VALUES (?,?,?,?)',
      [id, actor.id, actor.role, body.trim()]);
    return { id: res.insertId };
  },

  comments: (id: number) =>
    query<Row[]>(
      `SELECT c.*, u.name AS author_name FROM change_request_comments c
         JOIN users u ON u.id = c.author_id
        WHERE c.request_id = ? ORDER BY c.id`, [id]),

  versions: (id: number) =>
    query<Row[]>('SELECT * FROM change_request_versions WHERE request_id = ? ORDER BY version', [id]),

  // ─────────────────────── spending a one-time grant ────────────────────────

  /**
   * The gate every edit/delete path calls before touching a protected row.
   *
   * The CEO passes straight through. Everyone else needs a live grant for this
   * exact row, and using it consumes it — the same approval cannot cover a
   * second edit.
   */
  async assertMayChange(
    companyId: number, actor: Actor, kind: ChangeKind, entity: string, entityId: number,
  ): Promise<{ viaGrant: number | null }> {
    if (actor.role === ROLE.CEO) return { viaGrant: null };

    const rows = await query<Row[]>(
      `SELECT * FROM one_time_permissions
        WHERE company_id = ? AND user_id = ? AND entity = ? AND entity_id = ? AND kind = ?
        ORDER BY id DESC LIMIT 1`,
      [companyId, actor.id, entity, entityId, kind]);

    const grant = rows[0] ? {
      userId: Number(rows[0].user_id), kind: rows[0].kind as ChangeKind,
      entity: String(rows[0].entity), entityId: Number(rows[0].entity_id),
      usedAt: asDate(rows[0].used_at), revokedAt: asDate(rows[0].revoked_at),
      expiresAt: asDate(rows[0].expires_at),
    } : null;

    const check = canUseGrant(grant, actor, kind, entity, entityId);
    if (!check.usable) throw ApiError.forbidden(check.reason);
    return { viaGrant: Number(rows[0].id) };
  },

  /** Marks the grant spent. Called after the change actually succeeded. */
  async consumeGrant(grantId: number | null): Promise<void> {
    if (grantId == null) return;
    await exec('UPDATE one_time_permissions SET used_at = NOW() WHERE id = ? AND used_at IS NULL', [grantId]);
  },

  // ═══════════════════════════════ soft delete ══════════════════════════════

  /** Financial rows are never removed; they are marked and stay restorable. */
  async softDelete(companyId: number, actor: Actor, entity: string, entityId: number, reason: string) {
    if (!reason?.trim()) throw ApiError.badRequest('A delete reason is required.');
    assertKnownEntity(entity);
    const res = await exec(
      `UPDATE ${entity} SET deleted_at = NOW(), deleted_by = ?, delete_reason = ?
        WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
      [actor.id, reason.trim(), companyId, entityId]);
    if (!res.affectedRows) throw ApiError.notFound('Nothing to delete, or it is already deleted.');
    return { deleted: true };
  },

  async restore(companyId: number, actor: Actor, entity: string, entityId: number) {
    if (actor.role !== ROLE.CEO)
      throw ApiError.forbidden('Only the CEO can restore a deleted transaction.');
    assertKnownEntity(entity);
    const res = await exec(
      `UPDATE ${entity} SET deleted_at = NULL, deleted_by = NULL,
              restored_at = NOW(), restored_by = ?
        WHERE company_id = ? AND id = ? AND deleted_at IS NOT NULL`,
      [actor.id, companyId, entityId]);
    if (!res.affectedRows) throw ApiError.notFound('Nothing to restore.');
    return { restored: true };
  },

  /** What a pending delete means for the accounts: nothing, until approved. */
  deleteStatus: (isFinancial: boolean, status: ChangeRequestState['status']) =>
    deleteEffect(isFinancial, status),

  // ═════════════════════════ backdated access (BDR) ═════════════════════════

  async createBdr(companyId: number, actor: BdrActor, input: {
    module: BdrModule; from: string; to: string; reason: string; priority?: Priority;
  }) {
    if (!canRequestBdr(actor))
      throw ApiError.forbidden('Your role cannot request backdated access.');
    const check = validateRequest(input);
    if (!check.ok) throw ApiError.badRequest(check.error!);

    const created = await withTransaction(async (conn) => {
      const requestNo = await nextRequestNo(conn, companyId, 'BDR');
      const [res] = await conn.query<WriteResult>(
        `INSERT INTO backdated_access_requests
           (company_id, request_no, module, requested_from, requested_to, reason,
            priority, requested_by, requested_role)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [companyId, requestNo, input.module, input.from, input.to, input.reason.trim(),
         input.priority ?? 'NORMAL', actor.id, actor.role]);
      return { id: res.insertId, requestNo };
    });

    await this.notifyApprovers(companyId, 'BDR_CREATED', created.id,
      `${created.requestNo} — backdated access for ${input.module}`,
      `${input.from} to ${input.to}\nReason: ${input.reason.trim()}`,
      notifyImmediately(input.priority ?? 'NORMAL'));
    return created;
  },

  async getBdr(companyId: number, id: number) {
    const rows = await query<Row[]>(
      'SELECT * FROM backdated_access_requests WHERE company_id = ? AND id = ?', [companyId, id]);
    if (!rows[0]) throw ApiError.notFound('Backdated access request not found.');
    return rows[0];
  },

  listBdr: (companyId: number, filter: { status?: string; mine?: number }) => {
    const where = ['company_id = ?'];
    const params: unknown[] = [companyId];
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter.mine) { where.push('requested_by = ?'); params.push(filter.mine); }
    return query<Row[]>(
      `SELECT * FROM backdated_access_requests WHERE ${where.join(' AND ')}
        ORDER BY FIELD(priority,'URGENT','HIGH','NORMAL','LOW'), id DESC LIMIT 200`, params);
  },

  /**
   * Approve, optionally narrowing the window.
   *
   * The module can never be changed and the range can never be widened — an
   * approver who could do either would be authoring the request rather than
   * deciding it.
   */
  async approveBdr(companyId: number, actor: BdrActor, id: number, input: {
    from?: string; to?: string; note?: string;
  }) {
    const row = await this.getBdr(companyId, id);
    const request = toBdr(row);

    if (!canApproveBdr(actor, request))
      throw ApiError.forbidden(
        actor.id === request.requestedBy
          ? 'You cannot approve your own backdated access.'
          : 'Only the CEO or an Admin the CEO has authorised may approve backdated access.');

    const grant = approveRange(request, input.from, input.to);
    if (!grant.ok) throw ApiError.badRequest(grant.error!);

    await exec(
      `UPDATE backdated_access_requests
          SET status = 'APPROVED', approved_from = ?, approved_to = ?, expires_at = ?,
              decided_by = ?, decided_role = ?, decided_at = NOW(), decision_note = ?
        WHERE id = ?`,
      [grant.from, grant.to, grant.expiresAt, actor.id, actor.role, input.note ?? null, id]);

    await this.notifyRequester(companyId, request.requestedBy, 'BDR_APPROVED', id,
      `${row.request_no} approved`,
      `${grant.from} to ${grant.to}, valid ${VALIDITY_HOURS}h (until ${grant.expiresAt!.toISOString()}).`);

    return { status: 'APPROVED', from: grant.from, to: grant.to, expiresAt: grant.expiresAt };
  },

  async rejectBdr(companyId: number, actor: BdrActor, id: number, note?: string) {
    const row = await this.getBdr(companyId, id);
    const request = toBdr(row);
    if (!canApproveBdr(actor, request))
      throw ApiError.forbidden('Not authorised to decide backdated access.');
    if (request.status !== 'PENDING')
      throw ApiError.badRequest(`This request is ${request.status.toLowerCase()}.`);

    await exec(
      `UPDATE backdated_access_requests
          SET status = 'REJECTED', decided_by = ?, decided_role = ?, decided_at = NOW(), decision_note = ?
        WHERE id = ?`, [actor.id, actor.role, note ?? null, id]);
    await this.notifyRequester(companyId, request.requestedBy, 'BDR_REJECTED', id,
      `${row.request_no} rejected`, note ?? '');
    return { status: 'REJECTED' };
  },

  async cancelBdr(companyId: number, actor: BdrActor, id: number, reason: string) {
    if (!reason?.trim()) throw ApiError.badRequest('A cancel reason is required.');
    const row = await this.getBdr(companyId, id);
    const check = canCancel(actor, toBdr(row));
    if (!check.ok) throw ApiError.forbidden(check.error!);

    await exec(
      "UPDATE backdated_access_requests SET status = 'CANCELLED', cancel_reason = ?, cancelled_at = NOW() WHERE id = ?",
      [reason.trim(), id]);
    return { status: 'CANCELLED' };
  },

  async revokeBdr(companyId: number, actor: BdrActor, id: number, reason: string) {
    if (!reason?.trim()) throw ApiError.badRequest('A revoke reason is required.');
    const row = await this.getBdr(companyId, id);
    const check = canRevoke(actor, toBdr(row));
    if (!check.ok) throw ApiError.forbidden(check.error!);

    await exec(
      `UPDATE backdated_access_requests
          SET status = 'REVOKED', revoked_by = ?, revoked_at = NOW(), revoke_reason = ?
        WHERE id = ?`, [actor.id, reason.trim(), id]);
    await this.notifyRequester(companyId, Number(row.requested_by), 'BDR_REVOKED', id,
      `${row.request_no} revoked`, reason.trim());
    return { status: 'REVOKED' };
  },

  /**
   * The live window for this user and module, if any.
   *
   * Expiry is applied on read rather than by a scheduled job: a background
   * sweep that has not run yet would leave expired access looking live, and
   * the clock is the authority here, not a cron.
   */
  async activeBdr(companyId: number, userId: number, module: BdrModule): Promise<BdrRequest | null> {
    const rows = await query<Row[]>(
      `SELECT * FROM backdated_access_requests
        WHERE company_id = ? AND requested_by = ? AND module = ? AND status = 'APPROVED'
        ORDER BY expires_at DESC LIMIT 1`,
      [companyId, userId, module]);
    return rows[0] ? toBdr(rows[0]) : null;
  },

  /** Called by posting paths before writing a backdated transaction. */
  async assertBackdatedAllowed(
    companyId: number, actor: { id: number }, module: BdrModule, transactionDate: string,
  ): Promise<{ bdrId: number | null }> {
    const [company] = await query<Row[]>(
      'SELECT bdr_grace_minutes FROM companies WHERE id = ?', [companyId]);
    const grace = Number(company?.bdr_grace_minutes ?? 10);

    const active = await this.activeBdr(companyId, actor.id, module);
    const check = coversTransaction(active, actor, module, transactionDate, new Date(), grace);
    if (!check.allowed) throw ApiError.forbidden(check.reason);
    return { bdrId: active?.id ?? null };
  },

  // ═══════════════════════════ admin authority ══════════════════════════════

  async grantAdminAuthority(companyId: number, ceo: Actor, input: {
    userId: number; scope: 'CHANGE_REVIEW' | 'BDR_APPROVE'; note?: string;
  }) {
    if (ceo.role !== ROLE.CEO) throw ApiError.forbidden('Only the CEO grants approval authority.');
    const res = await exec(
      `INSERT INTO admin_approval_grants (company_id, user_id, scope, granted_by, granted_at, note)
       VALUES (?,?,?,?,NOW(),?)`,
      [companyId, input.userId, input.scope, ceo.id, input.note ?? null]);
    return { id: res.insertId };
  },

  async revokeAdminAuthority(companyId: number, ceo: Actor, grantId: number) {
    if (ceo.role !== ROLE.CEO) throw ApiError.forbidden('Only the CEO revokes approval authority.');
    const res = await exec(
      `UPDATE admin_approval_grants SET revoked_by = ?, revoked_at = NOW()
        WHERE company_id = ? AND id = ? AND revoked_at IS NULL`,
      [ceo.id, companyId, grantId]);
    if (!res.affectedRows) throw ApiError.notFound('Grant not found, or already revoked.');
    return { revoked: true };
  },

  listAdminGrants: (companyId: number) =>
    query<Row[]>(
      `SELECT g.*, u.name AS user_name FROM admin_approval_grants g
         JOIN users u ON u.id = g.user_id
        WHERE g.company_id = ? ORDER BY g.id DESC`, [companyId]),

  // ══════════════════════════════ notifying ═════════════════════════════════

  async notifyApprovers(
    companyId: number, event: string, requestId: number,
    subject: string, body: string, urgent: boolean,
  ) {
    const recipients = await notificationsService.approverRecipients(companyId);
    await notificationsService.notify({
      companyId, event, requestId, urgent,
      requestType: event.startsWith('BDR') ? 'BDR' : 'CHANGE',
      recipients: recipients.map((r) => ({ id: Number(r.id), email: r.email as string | null })),
      subject: urgent ? `[URGENT] ${subject}` : subject,
      body,
    });
  },

  async notifyRequester(
    companyId: number, userId: number, event: string, requestId: number,
    subject: string, body: string,
  ) {
    const rows = await query<Row[]>('SELECT id, email FROM users WHERE id = ?', [userId]);
    if (!rows[0]) return;
    await notificationsService.notify({
      companyId, event, requestId,
      requestType: event.startsWith('BDR') ? 'BDR' : 'CHANGE',
      recipients: [{ id: Number(rows[0].id), email: rows[0].email as string | null }],
      subject, body,
    });
  },
};

/**
 * Table names reach SQL as identifiers, so they can never come from request
 * data. This is the whitelist, and it is checked rather than escaped because
 * escaping an identifier still lets an attacker name a table.
 */
function assertKnownEntity(entity: string): void {
  if (!['vouchers', 'payments', 'invoices', 'bookings'].includes(entity))
    throw ApiError.badRequest(`"${entity}" is not a transaction table that supports soft delete.`);
}
