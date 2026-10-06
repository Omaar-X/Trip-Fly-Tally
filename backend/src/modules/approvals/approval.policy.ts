import { RoleName, ROLE } from '../../constants/roles';
import { today } from '../../utils/date';

/**
 * ========================= WHO MAY WRITE, AND WHEN =========================
 * RBAC (middleware/rbac.ts) answers "may this role reach this route at all".
 * This file answers the question that comes after it: "may what they just
 * submitted go straight into the books, or must someone senior say yes first".
 *
 * One decision function, so a new posting path cannot quietly slip past the
 * rule by forgetting to ask — the same reason assertPostable lives alone.
 *
 * The policy, as the CEO set it:
 *
 *   CEO         writes directly. Someone has to be the top of the ladder.
 *   ADMIN       every entry waits for the CEO — but ADMIN still decides other
 *               people's requests.
 *   ACCOUNTANT  day-to-day work is direct. Reaching backwards in time, or
 *               correcting an entry somebody else made, waits.
 *   SALES       selling is direct. Cancelling a confirmed booking — which
 *               voids an invoice and unwinds its vouchers — waits.
 *
 * Nobody decides their own request, whatever their role. An approver who can
 * wave through work they submitted themselves is not a control, only a
 * formality.
 * ===========================================================================
 */

export const APPROVAL_ACTIONS = [
  'VOUCHER_CREATE', 'VOUCHER_REVERSE',
  'BOOKING_CREATE', 'BOOKING_CONFIRM', 'BOOKING_CANCEL',
  'INVOICE_CREATE', 'PAYMENT_RECORD', 'PAYMENT_REVERSE',
  'STOCK_MOVEMENT', 'STOCK_MOVEMENT_REVERSE',
] as const;
export type ApprovalAction = typeof APPROVAL_ACTIONS[number];

/**
 * Actions that unwind something already posted. These always wait, for every
 * role below CEO, however recent the document is: undoing a confirmed sale is
 * not the same kind of act as making one.
 */
const UNDOING: ReadonlySet<ApprovalAction> = new Set<ApprovalAction>([
  'VOUCHER_REVERSE', 'BOOKING_CANCEL', 'PAYMENT_REVERSE', 'STOCK_MOVEMENT_REVERSE',
]);

export interface ApprovalContext {
  action: ApprovalAction;
  /** Role of whoever submitted it. */
  role: RoleName;
  /** User id of whoever submitted it. */
  requesterId: number;
  /**
   * Date the entry would carry. Omitted for actions that take their date from
   * the document rather than the operator (a reversal always posts today).
   */
  effectiveDate?: string;
  /**
   * For a correction: who posted the entry being corrected. Correcting your
   * own recent slip is not the same as reaching into a colleague's work, so
   * the two are told apart here.
   */
  originalAuthorId?: number | null;
}

export interface ApprovalDecision {
  required: boolean;
  /** Roles that may decide it. Empty when nothing needs deciding. */
  approvers: RoleName[];
  /** Shown to the requester, so a wait is never unexplained. */
  reason: string;
}

const DIRECT: ApprovalDecision = { required: false, approvers: [], reason: '' };

/**
 * How old a date may be before it counts as reaching backwards. Comes from
 * companies.back_entry_grace_days; 0 means anything not dated today waits.
 */
export function isBackEntry(date: string, graceDays: number, now = today()): boolean {
  return date < shiftDays(now, -Math.max(0, graceDays));
}

/** YYYY-MM-DD arithmetic that cannot drift across a timezone. */
export function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The single gate. Returns whether this submission may post now, and if not,
 * who can release it.
 */
export function decideApproval(ctx: ApprovalContext, graceDays: number, now = today()): ApprovalDecision {
  // The CEO owns the books. Nothing above to appeal to.
  if (ctx.role === ROLE.CEO) return DIRECT;

  // Every ADMIN entry waits, and only the CEO may release it: an approver who
  // could also release their own work would be approving themselves by proxy.
  if (ctx.role === ROLE.ADMIN)
    return { required: true, approvers: [ROLE.CEO], reason: 'Every Admin entry is confirmed by the CEO.' };

  const approvers = [ROLE.ADMIN, ROLE.CEO];

  if (UNDOING.has(ctx.action)) {
    // Correcting your own slip, while it is still recent, is ordinary work.
    // Denying it would change nothing in practice: the same person may post a
    // mirroring entry by hand today, and that one would not even be linked to
    // what it undoes. Allowing the proper route keeps the audit trail whole.
    const isOwn = ctx.originalAuthorId != null && ctx.originalAuthorId === ctx.requesterId;
    const stillRecent = ctx.effectiveDate ? !isBackEntry(ctx.effectiveDate, graceDays, now) : false;
    if (ctx.role === ROLE.ACCOUNTANT && isOwn && stillRecent) return DIRECT;

    return {
      required: true, approvers,
      reason: isOwn
        ? 'Undoing an entry older than the correction window needs approval.'
        : 'Undoing an entry posted by someone else needs approval.',
    };
  }

  if (ctx.effectiveDate && isBackEntry(ctx.effectiveDate, graceDays, now))
    return {
      required: true, approvers,
      reason: `Dated ${ctx.effectiveDate}, which is older than the ${graceDays}-day entry window.`,
    };

  return DIRECT;
}

/**
 * May this user decide this request? Role is necessary but not sufficient —
 * the requester is excluded even when their role appears in the list, which is
 * what stops an Admin from releasing their own entry after a role change, or a
 * CEO-approved action from being self-signed through a second account.
 */
export function canDecide(
  decision: Pick<ApprovalDecision, 'approvers'>,
  decider: { id: number; role: RoleName },
  requesterId: number
): boolean {
  if (decider.id === requesterId) return false;
  return decision.approvers.includes(decider.role);
}
