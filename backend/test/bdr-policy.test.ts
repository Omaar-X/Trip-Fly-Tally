import { describe, it, expect } from 'vitest';
import { ROLE } from '../src/constants/roles';
import {
  BdrActor, BdrRequest, DEFAULT_GRACE_MINUTES, VALIDITY_HOURS,
  approveRange, canApproveBdr, canCancel, canRequestBdr, canRevoke,
  coversTransaction, isExpired, isFutureDated, needsBackdatedAccess, validateRequest,
} from '../src/modules/approvals/bdr.policy';

const ceo: BdrActor = { id: 1, role: ROLE.CEO };
const plainAdmin: BdrActor = { id: 2, role: ROLE.ADMIN };
const authorisedAdmin: BdrActor = { id: 2, role: ROLE.ADMIN, canApproveBdr: true };
const accountant: BdrActor = { id: 3, role: ROLE.ACCOUNTANT };
const otherUser = { id: 9 };

const bdr = (over: Partial<BdrRequest> = {}): BdrRequest => ({
  id: 1, module: 'PAYMENT',
  requestedFrom: '2026-08-01', requestedTo: '2026-08-20',
  approvedFrom: null, approvedTo: null,
  status: 'PENDING', requestedBy: accountant.id, expiresAt: null, ...over,
});

const NOW = '2026-08-29';

// ─────────────────────────────── raising one ────────────────────────────────

describe('raising a BDR', () => {
  it('needs a reason', () => {
    expect(validateRequest({ module: 'PAYMENT', from: '2026-08-01', to: '2026-08-10', reason: '  ' }, NOW))
      .toMatchObject({ ok: false, error: expect.stringMatching(/reason/i) });
  });

  it('needs both dates, in order', () => {
    expect(validateRequest({ module: 'PAYMENT', from: '2026-08-10', to: '2026-08-01', reason: 'catch-up' }, NOW).ok)
      .toBe(false);
  });

  it('accepts any length of range — there is no maximum', () => {
    // Three months of catch-up is one request, not ninety.
    expect(validateRequest({ module: 'VOUCHER', from: '2026-05-01', to: '2026-08-01', reason: 'catch-up' }, NOW))
      .toEqual({ ok: true });
  });

  it('refuses a window reaching into the future', () => {
    expect(validateRequest({ module: 'PAYMENT', from: '2026-08-01', to: '2026-09-30', reason: 'x' }, NOW).ok)
      .toBe(false);
  });

  it('is open to accountant, sales and admin, closed to HR', () => {
    expect(canRequestBdr(accountant)).toBe(true);
    expect(canRequestBdr({ id: 7, role: ROLE.SALES })).toBe(true);
    expect(canRequestBdr(plainAdmin)).toBe(true);
    expect(canRequestBdr({ id: 8, role: ROLE.HR })).toBe(false);
  });
});

// ──────────────────────────── who may approve ───────────────────────────────

describe('either the CEO or an authorised Admin — one signature is enough', () => {
  it('accepts the CEO', () => {
    expect(canApproveBdr(ceo, bdr())).toBe(true);
  });

  it('accepts an Admin the CEO authorised, with no second signature needed', () => {
    // This is the one place Admin authority is final, unlike edit/delete.
    expect(canApproveBdr(authorisedAdmin, bdr())).toBe(true);
  });

  it('refuses an Admin without the grant', () => {
    expect(canApproveBdr(plainAdmin, bdr())).toBe(false);
  });

  it('refuses self-approval', () => {
    expect(canApproveBdr(ceo, bdr({ requestedBy: ceo.id }))).toBe(false);
  });
});

// ───────────────────────── narrowing, never widening ────────────────────────

describe('an approver may reduce the range but never extend it', () => {
  it('grants exactly what was asked when nothing is specified', () => {
    const g = approveRange(bdr(), undefined, undefined);
    expect(g).toMatchObject({ ok: true, from: '2026-08-01', to: '2026-08-20' });
  });

  it('allows a narrower window', () => {
    expect(approveRange(bdr(), '2026-08-05', '2026-08-10'))
      .toMatchObject({ ok: true, from: '2026-08-05', to: '2026-08-10' });
  });

  it('refuses an earlier start than requested', () => {
    expect(approveRange(bdr(), '2026-07-01', undefined))
      .toMatchObject({ ok: false, error: expect.stringMatching(/not extend it earlier/i) });
  });

  it('refuses a later end than requested', () => {
    expect(approveRange(bdr(), undefined, '2026-08-25'))
      .toMatchObject({ ok: false, error: expect.stringMatching(/not extend it later/i) });
  });

  it('refuses an inverted grant', () => {
    expect(approveRange(bdr(), '2026-08-15', '2026-08-05').ok).toBe(false);
  });

  it('will not approve a request that is not pending', () => {
    expect(approveRange(bdr({ status: 'CANCELLED' }), undefined, undefined).ok).toBe(false);
  });

  it(`sets expiry ${VALIDITY_HOURS} hours after approval`, () => {
    const at = new Date('2026-08-29T15:30:00Z');
    const g = approveRange(bdr(), undefined, undefined, at);
    expect(g.expiresAt!.toISOString()).toBe('2026-08-30T15:30:00.000Z');
  });
});

// ─────────────────────────────── using it ───────────────────────────────────

describe('scope: one user, one module, one date range', () => {
  const approved = bdr({
    status: 'APPROVED', approvedFrom: '2026-08-05', approvedTo: '2026-08-10',
    expiresAt: new Date('2026-08-30T15:30:00Z'),
  });
  const inWindow = new Date('2026-08-29T16:00:00Z');

  it('allows a covered entry', () => {
    expect(coversTransaction(approved, accountant, 'PAYMENT', '2026-08-07', inWindow))
      .toMatchObject({ allowed: true });
  });

  it('refuses a date outside the approved range', () => {
    expect(coversTransaction(approved, accountant, 'PAYMENT', '2026-08-02', inWindow))
      .toMatchObject({ allowed: false, reason: expect.stringMatching(/covers 2026-08-05 to 2026-08-10/) });
  });

  it('refuses another module', () => {
    expect(coversTransaction(approved, accountant, 'VOUCHER', '2026-08-07', inWindow))
      .toMatchObject({ allowed: false, reason: expect.stringMatching(/covers PAYMENT/) });
  });

  it('refuses another user — access is not shareable', () => {
    expect(coversTransaction(approved, otherUser, 'PAYMENT', '2026-08-07', inWindow))
      .toMatchObject({ allowed: false, reason: expect.stringMatching(/one user/i) });
  });

  it('refuses when there is no approved access', () => {
    expect(coversTransaction(null, accountant, 'PAYMENT', '2026-08-07', inWindow).allowed).toBe(false);
  });

  it('refuses a revoked window', () => {
    expect(coversTransaction({ ...approved, status: 'REVOKED' }, accountant, 'PAYMENT', '2026-08-07', inWindow).allowed)
      .toBe(false);
  });

  it('allows as many entries as needed inside the window', () => {
    for (const d of ['2026-08-05', '2026-08-07', '2026-08-10'])
      expect(coversTransaction(approved, accountant, 'PAYMENT', d, inWindow).allowed).toBe(true);
  });
});

describe('24-hour expiry and the grace period', () => {
  const approved = bdr({
    status: 'APPROVED', approvedFrom: '2026-08-05', approvedTo: '2026-08-10',
    expiresAt: new Date('2026-08-30T15:30:00Z'),
  });

  it('works right up to the deadline', () => {
    expect(coversTransaction(approved, accountant, 'PAYMENT', '2026-08-07',
      new Date('2026-08-30T15:29:59Z')).allowed).toBe(true);
  });

  it('still works inside the grace window', () => {
    // The save that was already being typed at 3:29 lands at 3:35.
    expect(coversTransaction(approved, accountant, 'PAYMENT', '2026-08-07',
      new Date('2026-08-30T15:35:00Z'), DEFAULT_GRACE_MINUTES).allowed).toBe(true);
  });

  it('stops once the grace window closes', () => {
    expect(coversTransaction(approved, accountant, 'PAYMENT', '2026-08-07',
      new Date('2026-08-30T15:41:00Z'), DEFAULT_GRACE_MINUTES))
      .toMatchObject({ allowed: false, reason: expect.stringMatching(/expired/i) });
  });

  it('honours a configured grace period other than the default', () => {
    expect(coversTransaction(approved, accountant, 'PAYMENT', '2026-08-07',
      new Date('2026-08-30T15:41:00Z'), 30).allowed).toBe(true);
    expect(coversTransaction(approved, accountant, 'PAYMENT', '2026-08-07',
      new Date('2026-08-30T15:31:00Z'), 0).allowed).toBe(false);
  });

  it('reports expiry from the clock, not from a status column', () => {
    expect(isExpired(approved, new Date('2026-08-30T15:31:00Z'))).toBe(true);
    expect(isExpired(approved, new Date('2026-08-30T15:29:00Z'))).toBe(false);
  });

  it('defaults the grace period to 10 minutes', () => {
    expect(DEFAULT_GRACE_MINUTES).toBe(10);
  });
});

// ───────────────────────── cancelling and revoking ──────────────────────────

describe('cancel and revoke', () => {
  it('lets the requester cancel while pending', () => {
    expect(canCancel(accountant, bdr())).toEqual({ ok: true });
  });

  it('stops anyone else cancelling', () => {
    expect(canCancel(ceo, bdr()).ok).toBe(false);
  });

  it('stops a cancel once approved', () => {
    expect(canCancel(accountant, bdr({ status: 'APPROVED' })).ok).toBe(false);
  });

  it('lets the CEO revoke approved access early', () => {
    expect(canRevoke(ceo, bdr({ status: 'APPROVED' }))).toEqual({ ok: true });
  });

  it('lets an authorised Admin revoke', () => {
    expect(canRevoke(authorisedAdmin, bdr({ status: 'APPROVED' }))).toEqual({ ok: true });
  });

  it('refuses an unauthorised Admin', () => {
    expect(canRevoke(plainAdmin, bdr({ status: 'APPROVED' })).ok).toBe(false);
  });

  it('has nothing to revoke on a pending request', () => {
    expect(canRevoke(ceo, bdr()).ok).toBe(false);
  });
});

// ───────────────────── ordinary work and future dates ───────────────────────

describe('future dating is refused for everyone', () => {
  it('flags a date after today', () => {
    expect(isFutureDated('2026-08-30', NOW)).toBe(true);
  });

  it('accepts today and the past', () => {
    expect(isFutureDated('2026-08-29', NOW)).toBe(false);
    expect(isFutureDated('2020-01-01', NOW)).toBe(false);
  });
});

describe('when a BDR is needed at all', () => {
  it('is not needed inside the ordinary grace window', () => {
    expect(needsBackdatedAccess('2026-08-25', 7, NOW)).toBe(false);
  });

  it('is needed once the entry is older than the window', () => {
    expect(needsBackdatedAccess('2026-08-20', 7, NOW)).toBe(true);
  });

  it('treats a zero-day window as "anything but today"', () => {
    expect(needsBackdatedAccess('2026-08-28', 0, NOW)).toBe(true);
    expect(needsBackdatedAccess('2026-08-29', 0, NOW)).toBe(false);
  });
});
