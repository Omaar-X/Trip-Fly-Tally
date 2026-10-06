import { describe, it, expect } from 'vitest';
import { ROLE } from '../src/constants/roles';
import {
  Actor, ChangeRequestState,
  affectsAccounting, canChangeDirectly, canDecideFinally, canRecommend, canRequestChange,
  canRestore, canUseGrant, deleteEffect, formatRequestNo, isFinal, isOpen,
  notifyImmediately, requestPrefix, transition,
} from '../src/modules/approvals/changeRequest.policy';

const ceo: Actor = { id: 1, role: ROLE.CEO };
const admin: Actor = { id: 2, role: ROLE.ADMIN };
const authorisedAdmin: Actor = { id: 2, role: ROLE.ADMIN, canReviewAsAdmin: true };
const accountant: Actor = { id: 3, role: ROLE.ACCOUNTANT };
const sales: Actor = { id: 4, role: ROLE.SALES };
const hr: Actor = { id: 5, role: ROLE.HR };

const request = (over: Partial<ChangeRequestState> = {}): ChangeRequestState => ({
  id: 10, kind: 'EDIT', status: 'PENDING', requestedBy: accountant.id,
  isFinancial: true, version: 1, ...over,
});

// ──────────────────────────── who edits directly ────────────────────────────

describe('CEO edits directly, nobody else does', () => {
  it('lets the CEO through without a request', () => {
    expect(canChangeDirectly(ceo, 'EDIT')).toMatchObject({ allowed: true, needsRequest: false });
    expect(canChangeDirectly(ceo, 'DELETE')).toMatchObject({ allowed: true, needsRequest: false });
  });

  it.each([[accountant, 'accountant'], [sales, 'sales'], [admin, 'admin']] as const)(
    'sends %#(%s) to the request flow', (actor) => {
      const v = canChangeDirectly(actor as Actor, 'EDIT');
      expect(v.allowed).toBe(false);
      expect(v.needsRequest).toBe(true);
    });

  it('gives HR no route at all — not even a request', () => {
    const v = canChangeDirectly(hr, 'EDIT');
    expect(v.allowed).toBe(false);
    expect(v.needsRequest).toBe(false);
    expect(canRequestChange(hr)).toBe(false);
  });
});

// ───────────────────────────── request numbers ──────────────────────────────

describe('request identifiers', () => {
  it('numbers edits and deletes in their own series', () => {
    expect(formatRequestNo('EDT', 2026, 1)).toBe('EDT-2026-00001');
    expect(formatRequestNo('DEL', 2026, 42)).toBe('DEL-2026-00042');
    expect(formatRequestNo('BDR', 2026, 12345)).toBe('BDR-2026-12345');
  });

  it('picks the prefix from the kind', () => {
    expect(requestPrefix('EDIT')).toBe('EDT');
    expect(requestPrefix('DELETE')).toBe('DEL');
  });
});

// ──────────────────────── admin recommends, CEO decides ─────────────────────

describe('admin recommendation is not a decision', () => {
  it('refuses an Admin without the CEO grant', () => {
    expect(canRecommend(admin, request())).toBe(false);
    expect(transition(request(), 'RECOMMEND', admin).ok).toBe(false);
  });

  it('accepts an authorised Admin', () => {
    expect(canRecommend(authorisedAdmin, request())).toBe(true);
    expect(transition(request(), 'RECOMMEND', authorisedAdmin))
      .toMatchObject({ ok: true, status: 'ADMIN_REVIEWED' });
  });

  it('still leaves the final call to the CEO', () => {
    expect(canDecideFinally(authorisedAdmin, request())).toBe(false);
    expect(transition(request(), 'APPROVE', authorisedAdmin).ok).toBe(false);
  });

  it('lets the CEO approve without any admin review at all', () => {
    // Admin review is optional; the CEO may bypass it entirely.
    expect(transition(request({ status: 'PENDING' }), 'APPROVE', ceo))
      .toMatchObject({ ok: true, status: 'APPROVED' });
  });

  it('lets the CEO decide a request an Admin already reviewed', () => {
    expect(transition(request({ status: 'ADMIN_REVIEWED' }), 'REJECT', ceo))
      .toMatchObject({ ok: true, status: 'REJECTED' });
  });
});

describe('nobody decides their own request', () => {
  it('blocks a CEO who raised it', () => {
    const own = request({ requestedBy: ceo.id });
    expect(canDecideFinally(ceo, own)).toBe(false);
    expect(transition(own, 'APPROVE', ceo).error).toMatch(/your own request/i);
  });

  it('blocks an authorised Admin from recommending on their own', () => {
    expect(canRecommend(authorisedAdmin, request({ requestedBy: authorisedAdmin.id }))).toBe(false);
  });
});

// ─────────────────────── rejection, correction, resubmit ────────────────────

describe('rejection is not the end of the conversation', () => {
  it('lets the requester resubmit a rejected request', () => {
    expect(transition(request({ status: 'REJECTED' }), 'RESUBMIT', accountant))
      .toMatchObject({ ok: true, status: 'RESUBMITTED' });
  });

  it('lets the requester answer a needs-correction', () => {
    expect(transition(request({ status: 'NEEDS_CORRECTION' }), 'RESUBMIT', accountant))
      .toMatchObject({ ok: true, status: 'RESUBMITTED' });
  });

  it('lets only the requester resubmit', () => {
    expect(transition(request({ status: 'REJECTED' }), 'RESUBMIT', sales).ok).toBe(false);
  });

  it('will not resubmit something still pending', () => {
    expect(transition(request({ status: 'PENDING' }), 'RESUBMIT', accountant).ok).toBe(false);
  });

  it('lets the CEO send it back for correction', () => {
    expect(transition(request(), 'NEEDS_CORRECTION', ceo))
      .toMatchObject({ ok: true, status: 'NEEDS_CORRECTION' });
  });

  it('accepts a decision on a resubmitted request', () => {
    expect(transition(request({ status: 'RESUBMITTED' }), 'APPROVE', ceo))
      .toMatchObject({ ok: true, status: 'APPROVED' });
  });
});

// ──────────────────────────────── cancelling ────────────────────────────────

describe('cancellation', () => {
  it.each(['PENDING', 'NEEDS_CORRECTION', 'RESUBMITTED', 'ADMIN_REVIEWED'] as const)(
    'lets the requester cancel while %s', (status) => {
      expect(transition(request({ status }), 'CANCEL', accountant))
        .toMatchObject({ ok: true, status: 'CANCELLED' });
    });

  it.each(['APPROVED', 'REJECTED', 'CANCELLED'] as const)(
    'refuses to cancel once %s', (status) => {
      expect(transition(request({ status }), 'CANCEL', accountant).ok).toBe(false);
    });

  it('lets nobody else cancel it', () => {
    expect(transition(request(), 'CANCEL', ceo).error).toMatch(/only the requester/i);
  });
});

describe('open and final states', () => {
  it.each(['PENDING', 'NEEDS_CORRECTION', 'RESUBMITTED', 'ADMIN_REVIEWED'] as const)(
    '%s is open', (s) => { expect(isOpen(s)).toBe(true); expect(isFinal(s)).toBe(false); });

  it.each(['APPROVED', 'REJECTED', 'CANCELLED'] as const)(
    '%s is final', (s) => { expect(isFinal(s)).toBe(true); expect(isOpen(s)).toBe(false); });

  it('refuses to decide an already-decided request', () => {
    expect(transition(request({ status: 'APPROVED' }), 'APPROVE', ceo).ok).toBe(false);
  });
});

// ───────────────── a pending change does not touch the accounts ─────────────

describe('a pending change leaves the books alone', () => {
  it.each(['PENDING', 'NEEDS_CORRECTION', 'RESUBMITTED', 'ADMIN_REVIEWED', 'REJECTED', 'CANCELLED'] as const)(
    '%s has no accounting effect', (status) => {
      expect(affectsAccounting(request({ status }))).toBe(false);
    });

  it('only an approved request has one', () => {
    expect(affectsAccounting(request({ status: 'APPROVED' }))).toBe(true);
  });

  it('keeps a financial row active while its delete is pending', () => {
    const e = deleteEffect(true, 'PENDING');
    expect(e.effect).toBe('PENDING_APPROVAL');
    expect('reason' in e && e.reason).toMatch(/stays active in all balances/i);
  });

  it('soft deletes — never hard deletes — once approved', () => {
    expect(deleteEffect(true, 'APPROVED')).toEqual({ effect: 'SOFT_DELETE' });
    expect(deleteEffect(false, 'APPROVED')).toEqual({ effect: 'SOFT_DELETE' });
  });
});

describe('restore', () => {
  it('is the CEO’s alone', () => {
    expect(canRestore(ceo)).toBe(true);
    for (const a of [admin, authorisedAdmin, accountant, sales, hr]) expect(canRestore(a)).toBe(false);
  });
});

// ──────────────────────── one-time edit/delete access ───────────────────────

describe('an approval grants one use, on one row, to one user', () => {
  const grant = {
    userId: accountant.id, kind: 'EDIT' as const, entity: 'vouchers', entityId: 77,
    usedAt: null, revokedAt: null, expiresAt: null,
  };

  it('lets the approved user make the approved change', () => {
    expect(canUseGrant(grant, accountant, 'EDIT', 'vouchers', 77)).toMatchObject({ usable: true });
  });

  it('expires after one use', () => {
    const spent = { ...grant, usedAt: new Date('2026-08-01T10:00:00Z') };
    const v = canUseGrant(spent, accountant, 'EDIT', 'vouchers', 77);
    expect(v.usable).toBe(false);
    expect(v.reason).toMatch(/already been used/i);
  });

  it('does not transfer to another user', () => {
    expect(canUseGrant(grant, sales, 'EDIT', 'vouchers', 77))
      .toMatchObject({ usable: false, reason: expect.stringMatching(/another user/i) });
  });

  it('does not stretch to another transaction', () => {
    expect(canUseGrant(grant, accountant, 'EDIT', 'vouchers', 78))
      .toMatchObject({ usable: false, reason: expect.stringMatching(/different transaction/i) });
  });

  it('does not stretch to another table', () => {
    expect(canUseGrant(grant, accountant, 'EDIT', 'payments', 77).usable).toBe(false);
  });

  it('does not turn an approved edit into a delete', () => {
    expect(canUseGrant(grant, accountant, 'DELETE', 'vouchers', 77))
      .toMatchObject({ usable: false, reason: expect.stringMatching(/covers edit/i) });
  });

  it('stops working once revoked', () => {
    expect(canUseGrant({ ...grant, revokedAt: new Date() }, accountant, 'EDIT', 'vouchers', 77).usable)
      .toBe(false);
  });

  it('respects a wall-clock expiry', () => {
    const now = new Date('2026-08-29T12:00:00Z');
    const stale = { ...grant, expiresAt: new Date('2026-08-29T11:59:59Z') };
    expect(canUseGrant(stale, accountant, 'EDIT', 'vouchers', 77, now).usable).toBe(false);
  });

  it('refuses when there is no grant at all', () => {
    expect(canUseGrant(null, accountant, 'EDIT', 'vouchers', 77))
      .toMatchObject({ usable: false, reason: expect.stringMatching(/no approved permission/i) });
  });
});

// ──────────────────────────────── priority ──────────────────────────────────

describe('priority', () => {
  it('notifies immediately only for urgent', () => {
    expect(notifyImmediately('URGENT')).toBe(true);
    for (const p of ['LOW', 'NORMAL', 'HIGH'] as const) expect(notifyImmediately(p)).toBe(false);
  });
});
