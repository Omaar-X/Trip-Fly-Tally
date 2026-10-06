/**
 * ===================== BACKDATED ACCESS REQUESTS (BDR) ======================
 *
 * Permission to CREATE a transaction dated in the past — not permission to
 * touch one that already exists. That distinction is the whole design:
 *
 *   BDR                       "let me enter last week's receipts"
 *   change_requests           "let me alter this posted voucher"
 *
 * A BDR never grants edit or delete rights, and it can never be used to reach
 * imported historical data. Someone who wants to change a migrated transaction
 * raises a change request, whatever BDR window they happen to hold.
 *
 * Two rules distinguish this workflow from the edit/delete one:
 *
 *   · Either the CEO **or** an Admin the CEO has authorised may finally
 *     approve. There is no second signature.
 *   · The approver may NARROW what was asked for and may never widen it. An
 *     approver who can extend the window is writing the request themselves.
 * ===========================================================================
 */
import { ROLE, RoleName } from '../../constants/roles';
import { today } from '../../utils/date';

export type BdrModule = 'VOUCHER' | 'PAYMENT' | 'BOOKING' | 'INVOICE' | 'INVENTORY' | 'PAYROLL';

export type BdrStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REVOKED' | 'EXPIRED';

export interface BdrActor {
  id: number;
  role: RoleName;
  /** CEO-granted authority to finally approve backdated access. */
  canApproveBdr?: boolean;
}

export interface BdrRequest {
  id: number;
  module: BdrModule;
  requestedFrom: string;      // YYYY-MM-DD
  requestedTo: string;
  approvedFrom: string | null;
  approvedTo: string | null;
  status: BdrStatus;
  requestedBy: number;
  expiresAt: Date | null;
}

/** Approved access lasts a day. Long enough to finish the work, short enough to matter. */
export const VALIDITY_HOURS = 24;

/** Default grace after expiry; the company setting overrides it. */
export const DEFAULT_GRACE_MINUTES = 10;

// ──────────────────────────────── raising ───────────────────────────────────

export interface ValidationResult { ok: boolean; error?: string }

/**
 * One module, one date range, one reason — all mandatory, no maximum span.
 *
 * The client was explicit that there is no ceiling on the requested range: an
 * accountant catching up three months of receipts should ask for three months
 * rather than shred the request into daily slices nobody can review.
 */
export function validateRequest(input: {
  module: BdrModule; from: string; to: string; reason: string;
}, now: string = today()): ValidationResult {
  if (!input.reason?.trim()) return { ok: false, error: 'A reason is required.' };
  if (!input.from || !input.to) return { ok: false, error: 'Both From and To dates are required.' };
  if (input.from > input.to) return { ok: false, error: 'From date cannot be after To date.' };
  // Backdated means backdated. A future window is a different request entirely,
  // and future-dated transactions are refused outright (see isFutureDated).
  if (input.to > now) return { ok: false, error: 'Backdated access cannot cover a future date.' };
  return { ok: true };
}

export function canRequestBdr(actor: BdrActor): boolean {
  return actor.role === ROLE.ACCOUNTANT || actor.role === ROLE.SALES || actor.role === ROLE.ADMIN;
}

// ─────────────────────────────── approving ──────────────────────────────────

/**
 * Either signature is sufficient — unlike edit/delete, an authorised Admin's
 * approval is final and needs no CEO countersignature.
 */
export function canApproveBdr(actor: BdrActor, request: BdrRequest): boolean {
  if (actor.id === request.requestedBy) return false;
  if (actor.role === ROLE.CEO) return true;
  return actor.role === ROLE.ADMIN && actor.canApproveBdr === true;
}

export interface ApprovalGrant {
  ok: boolean;
  from?: string;
  to?: string;
  expiresAt?: Date;
  error?: string;
}

/**
 * Narrowing is allowed, widening is not.
 *
 * `grantFrom`/`grantTo` default to what was asked. Anything outside the
 * requested window is refused rather than clamped, because a silently clamped
 * approval reads to the requester as if they got what they asked for.
 */
export function approveRange(
  request: BdrRequest,
  grantFrom: string | undefined,
  grantTo: string | undefined,
  approvedAt: Date = new Date(),
): ApprovalGrant {
  if (request.status !== 'PENDING')
    return { ok: false, error: `This request is ${request.status.toLowerCase()} and can no longer be approved.` };

  const from = grantFrom ?? request.requestedFrom;
  const to = grantTo ?? request.requestedTo;

  if (from < request.requestedFrom)
    return { ok: false, error: 'An approver may narrow the requested range but not extend it earlier.' };
  if (to > request.requestedTo)
    return { ok: false, error: 'An approver may narrow the requested range but not extend it later.' };
  if (from > to)
    return { ok: false, error: 'Approved From date cannot be after the approved To date.' };

  const expiresAt = new Date(approvedAt.getTime() + VALIDITY_HOURS * 3600_000);
  return { ok: true, from, to, expiresAt };
}

// ─────────────────────────────── using it ───────────────────────────────────

export interface ScopeCheck { allowed: boolean; reason: string }

/**
 * Does this live BDR cover what the user is about to post?
 *
 * User, module and date all have to line up, and the window has to still be
 * open. The grace period exists for the person who started a legitimate entry
 * at 3:29 for a window closing at 3:30 — it extends the deadline for a save
 * already in flight, not the right to start new work.
 */
export function coversTransaction(
  request: BdrRequest | null,
  actor: { id: number },
  module: BdrModule,
  transactionDate: string,
  now: Date = new Date(),
  graceMinutes: number = DEFAULT_GRACE_MINUTES,
): ScopeCheck {
  if (!request) return { allowed: false, reason: 'No approved backdated access for this module.' };
  if (request.status !== 'APPROVED')
    return { allowed: false, reason: `Backdated access is ${request.status.toLowerCase()}.` };
  if (request.requestedBy !== actor.id)
    return { allowed: false, reason: 'Backdated access is granted to one user and cannot be shared.' };
  if (request.module !== module)
    return { allowed: false, reason: `This access covers ${request.module}, not ${module}. Raise another request.` };

  const from = request.approvedFrom ?? request.requestedFrom;
  const to = request.approvedTo ?? request.requestedTo;
  if (transactionDate < from || transactionDate > to)
    return { allowed: false, reason: `This access covers ${from} to ${to}; the entry is dated ${transactionDate}.` };

  if (request.expiresAt) {
    const deadline = request.expiresAt.getTime() + Math.max(0, graceMinutes) * 60_000;
    if (now.getTime() > deadline)
      return { allowed: false, reason: 'Backdated access has expired. Raise another request.' };
  }

  return { allowed: true, reason: '' };
}

/** Expiry is a fact about the clock, so it is derived rather than stored as a state. */
export function isExpired(request: BdrRequest, now: Date = new Date()): boolean {
  return request.status === 'APPROVED' && !!request.expiresAt && request.expiresAt.getTime() <= now.getTime();
}

// ───────────────────────── cancelling and revoking ──────────────────────────

export function canCancel(actor: BdrActor, request: BdrRequest): ValidationResult {
  if (actor.id !== request.requestedBy)
    return { ok: false, error: 'Only the requester may cancel their own request.' };
  if (request.status !== 'PENDING')
    return { ok: false, error: 'Only a pending request can be cancelled.' };
  return { ok: true };
}

/** Revoking cuts an approved window short; same authority that could grant it. */
export function canRevoke(actor: BdrActor, request: BdrRequest): ValidationResult {
  if (request.status !== 'APPROVED')
    return { ok: false, error: 'Only approved access can be revoked.' };
  const authorised = actor.role === ROLE.CEO || (actor.role === ROLE.ADMIN && actor.canApproveBdr === true);
  if (!authorised) return { ok: false, error: 'Only the CEO or an authorised Admin may revoke access.' };
  return { ok: true };
}

// ─────────────────────────── ordinary new work ──────────────────────────────

/**
 * A transaction dated after today is refused for everyone, BDR or not.
 *
 * Backdating is a controlled exception with a workflow behind it. Forward
 * dating has no workflow because there is no legitimate case for it: an entry
 * for a thing that has not happened yet is not a record, it is a guess.
 */
export function isFutureDated(transactionDate: string, now: string = today()): boolean {
  return transactionDate > now;
}

/**
 * Whether an entry counts as backdated, using the same grace window the
 * ordinary posting rules use. Inside it, no BDR is needed — that is what the
 * grace window is for.
 */
export function needsBackdatedAccess(
  transactionDate: string, graceDays: number, now: string = today(),
): boolean {
  const cutoff = new Date(`${now}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(0, graceDays));
  return transactionDate < cutoff.toISOString().slice(0, 10);
}
