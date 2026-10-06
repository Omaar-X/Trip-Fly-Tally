/**
 * ============== CHANGING SOMETHING THAT IS ALREADY IN THE BOOKS ==============
 *
 * `approval.policy.ts` next door answers "may this new entry post now". This
 * file answers the harder one: "may this person alter or remove an entry that
 * already exists".
 *
 * The shape the CEO asked for:
 *
 *   CEO          edits and deletes directly. Reason is mandatory, the
 *                before/after is logged, and a delete is always soft.
 *   ACCOUNTANT   must ask. Approval grants ONE use on ONE row — not a role.
 *   SALES        same.
 *   ADMIN        may *recommend*, and only when the CEO has granted it. The
 *                CEO can ignore or bypass the recommendation entirely.
 *
 * Two properties are worth stating because they are easy to lose:
 *
 *   1. Until the CEO finally approves, the ORIGINAL transaction is what the
 *      accounts show. A pending edit is a proposal, not a draft of the truth.
 *   2. The CEO cannot rewrite the requester's proposed values while deciding.
 *      Approve, reject, or send it back — anything else would turn a review
 *      into an edit nobody requested and nobody signed.
 * ===========================================================================
 */
import { ROLE, RoleName } from '../../constants/roles';

export type ChangeKind = 'EDIT' | 'DELETE';

export type ChangeStatus =
  | 'PENDING' | 'NEEDS_CORRECTION' | 'RESUBMITTED' | 'ADMIN_REVIEWED'
  | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export interface Actor {
  id: number;
  role: RoleName;
  /** CEO-granted authority to review change requests. Never enough to decide. */
  canReviewAsAdmin?: boolean;
}

export interface ChangeRequestState {
  id: number;
  kind: ChangeKind;
  status: ChangeStatus;
  requestedBy: number;
  isFinancial: boolean;
  version: number;
}

// ───────────────────────────── request numbers ──────────────────────────────

/**
 * EDT-2026-00001 / DEL-2026-00001 / BDR-2026-00001.
 *
 * Calendar year, not financial year: these are workflow tickets people quote
 * to each other, and "which FY was that in" is a question nobody should have
 * to answer to find a request.
 */
export function formatRequestNo(prefix: 'EDT' | 'DEL' | 'BDR', year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
}

export const requestPrefix = (kind: ChangeKind): 'EDT' | 'DEL' =>
  (kind === 'EDIT' ? 'EDT' : 'DEL');

// ─────────────────────────── who may do what ────────────────────────────────

export interface DirectVerdict {
  allowed: boolean;
  /** True when the actor must raise a request instead. */
  needsRequest: boolean;
  reason: string;
}

/**
 * May this actor change the row without asking anybody?
 *
 * Only the CEO. Everyone else raises a request — including Admin, who can
 * review other people's requests but has no authority over the books.
 */
export function canChangeDirectly(actor: Actor, kind: ChangeKind): DirectVerdict {
  if (actor.role === ROLE.CEO)
    return { allowed: true, needsRequest: false, reason: '' };

  if (actor.role === ROLE.HR)
    return {
      allowed: false, needsRequest: false,
      reason: 'HR has no access to financial transactions.',
    };

  return {
    allowed: false, needsRequest: true,
    reason: `${kind === 'EDIT' ? 'Editing' : 'Deleting'} an existing transaction needs CEO approval.`,
  };
}

/** Roles that may raise a change request at all. */
export function canRequestChange(actor: Actor): boolean {
  return actor.role === ROLE.ACCOUNTANT || actor.role === ROLE.ADMIN || actor.role === ROLE.SALES;
}

/**
 * May this actor give the final decision?
 *
 * The CEO, and only the CEO. An Admin with review authority recommends; that
 * is a different verb and a different column.
 *
 * The requester is excluded even if their role would otherwise qualify — an
 * approver who can release their own request is a formality, not a control.
 */
export function canDecideFinally(actor: Actor, request: ChangeRequestState): boolean {
  if (actor.id === request.requestedBy) return false;
  return actor.role === ROLE.CEO;
}

/** May this actor attach a recommendation? Requires the CEO's explicit grant. */
export function canRecommend(actor: Actor, request: ChangeRequestState): boolean {
  if (actor.id === request.requestedBy) return false;
  return actor.role === ROLE.ADMIN && actor.canReviewAsAdmin === true;
}

// ───────────────────────────── state machine ────────────────────────────────

const OPEN: readonly ChangeStatus[] = ['PENDING', 'NEEDS_CORRECTION', 'RESUBMITTED', 'ADMIN_REVIEWED'];
const FINAL: readonly ChangeStatus[] = ['APPROVED', 'REJECTED', 'CANCELLED'];

export const isOpen = (status: ChangeStatus): boolean => OPEN.includes(status);
export const isFinal = (status: ChangeStatus): boolean => FINAL.includes(status);

export type ChangeAction =
  | 'RECOMMEND' | 'APPROVE' | 'REJECT' | 'NEEDS_CORRECTION' | 'RESUBMIT' | 'CANCEL';

export interface TransitionResult {
  ok: boolean;
  status?: ChangeStatus;
  error?: string;
}

/**
 * The one place a request's status changes.
 *
 * Rejection does NOT close the conversation: the requester corrects and
 * resubmits the SAME request, so the history of what was asked, refused and
 * asked again stays in one thread instead of scattered across new tickets.
 */
export function transition(
  request: ChangeRequestState,
  action: ChangeAction,
  actor: Actor,
): TransitionResult {
  if (action === 'CANCEL') {
    if (actor.id !== request.requestedBy)
      return { ok: false, error: 'Only the requester may cancel their own request.' };
    if (isFinal(request.status))
      return { ok: false, error: `A ${request.status.toLowerCase()} request can no longer be cancelled.` };
    return { ok: true, status: 'CANCELLED' };
  }

  if (action === 'RESUBMIT') {
    if (actor.id !== request.requestedBy)
      return { ok: false, error: 'Only the requester may resubmit.' };
    if (request.status !== 'NEEDS_CORRECTION' && request.status !== 'REJECTED')
      return { ok: false, error: 'Only a rejected request or one needing correction can be resubmitted.' };
    return { ok: true, status: 'RESUBMITTED' };
  }

  if (action === 'RECOMMEND') {
    if (!canRecommend(actor, request))
      return { ok: false, error: 'Admin review authority is granted by the CEO and has not been granted.' };
    if (!isOpen(request.status))
      return { ok: false, error: 'This request has already been decided.' };
    return { ok: true, status: 'ADMIN_REVIEWED' };
  }

  // APPROVE / REJECT / NEEDS_CORRECTION — the CEO's three verbs.
  if (!canDecideFinally(actor, request))
    return {
      ok: false,
      error: actor.id === request.requestedBy
        ? 'You cannot decide your own request.'
        : 'Only the CEO gives the final decision on an edit or delete.',
    };
  if (!isOpen(request.status))
    return { ok: false, error: 'This request has already been decided.' };

  if (action === 'APPROVE') return { ok: true, status: 'APPROVED' };
  if (action === 'REJECT') return { ok: true, status: 'REJECTED' };
  return { ok: true, status: 'NEEDS_CORRECTION' };
}

/**
 * Whether the underlying transaction is affected by the request's current
 * state. Only an approved one is, and for a financial row "affected" still
 * means soft-deleted rather than gone.
 *
 * This is the invariant behind "a pending edit does not touch the accounts".
 */
export function affectsAccounting(request: ChangeRequestState): boolean {
  return request.status === 'APPROVED';
}

// ────────────────────────── one-time permission ─────────────────────────────

export interface OneTimeGrant {
  userId: number;
  kind: ChangeKind;
  entity: string;
  entityId: number;
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export interface GrantCheck { usable: boolean; reason: string }

/**
 * Approval hands out one use, for one user, on one row.
 *
 * Every clause below is a way the grant could otherwise be stretched: used by
 * someone else, spent twice, applied to a different row, or used to delete
 * when only an edit was approved.
 */
export function canUseGrant(
  grant: OneTimeGrant | null,
  actor: Actor,
  kind: ChangeKind,
  entity: string,
  entityId: number,
  now: Date = new Date(),
): GrantCheck {
  if (!grant) return { usable: false, reason: 'No approved permission for this transaction.' };
  if (grant.userId !== actor.id) return { usable: false, reason: 'This permission was granted to another user.' };
  if (grant.kind !== kind) return { usable: false, reason: `This permission covers ${grant.kind.toLowerCase()}, not ${kind.toLowerCase()}.` };
  if (grant.entity !== entity || grant.entityId !== entityId)
    return { usable: false, reason: 'This permission covers a different transaction.' };
  if (grant.revokedAt) return { usable: false, reason: 'This permission was revoked.' };
  if (grant.usedAt) return { usable: false, reason: 'This permission has already been used. Raise another request.' };
  if (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime())
    return { usable: false, reason: 'This permission has expired.' };
  return { usable: true, reason: '' };
}

// ──────────────────────────── delete behaviour ──────────────────────────────

export type DeleteEffect =
  | { effect: 'SOFT_DELETE' }
  | { effect: 'PENDING_APPROVAL'; reason: string };

/**
 * A financial row stays ACTIVE — in every balance and every report — until the
 * CEO finally approves its removal, and even then it is only soft deleted so
 * the CEO can restore it.
 */
export function deleteEffect(isFinancial: boolean, status: ChangeStatus): DeleteEffect {
  if (status === 'APPROVED') return { effect: 'SOFT_DELETE' };
  return {
    effect: 'PENDING_APPROVAL',
    reason: isFinancial
      ? 'The transaction stays active in all balances and reports until the CEO approves.'
      : 'Waiting for approval.',
  };
}

/** Only the CEO restores. Restoring is undoing a decision only the CEO made. */
export function canRestore(actor: Actor): boolean {
  return actor.role === ROLE.CEO;
}

export const URGENT: Priority = 'URGENT';

/** Urgent requests are highlighted and notified immediately. */
export function notifyImmediately(priority: Priority): boolean {
  return priority === URGENT;
}
