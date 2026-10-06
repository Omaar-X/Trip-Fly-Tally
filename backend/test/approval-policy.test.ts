import { describe, expect, it } from 'vitest';
import {
  decideApproval, canDecide, isBackEntry, shiftDays,
} from '../src/modules/approvals/approval.policy';

const NOW = '2026-08-19';
const GRACE = 7;
const ACCOUNTANT_ID = 11;
const ADMIN_ID = 12;
const CEO_ID = 1;

const ctx = (over: Partial<Parameters<typeof decideApproval>[0]> = {}) => ({
  action: 'VOUCHER_CREATE' as const,
  role: 'ACCOUNTANT' as const,
  requesterId: ACCOUNTANT_ID,
  effectiveDate: NOW,
  ...over,
});

describe('back-entry window', () => {
  it('counts the grace day itself as still inside the window', () => {
    // 7 days back from the 19th is the 12th: that day is the last one that
    // still posts directly, the 11th is the first that waits.
    expect(shiftDays(NOW, -GRACE)).toBe('2026-08-12');
    expect(isBackEntry('2026-08-12', GRACE, NOW)).toBe(false);
    expect(isBackEntry('2026-08-11', GRACE, NOW)).toBe(true);
  });

  it('crosses month and year boundaries without drifting', () => {
    expect(shiftDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('with a zero grace, only today posts directly', () => {
    expect(isBackEntry(NOW, 0, NOW)).toBe(false);
    expect(isBackEntry('2026-08-18', 0, NOW)).toBe(true);
  });
});

describe('who must wait', () => {
  it('lets the CEO post anything, however old', () => {
    expect(decideApproval(ctx({ role: 'CEO', requesterId: CEO_ID, effectiveDate: '2019-04-02' }), GRACE, NOW).required)
      .toBe(false);
  });

  it('sends every Admin entry to the CEO, even dated today', () => {
    const d = decideApproval(ctx({ role: 'ADMIN', requesterId: ADMIN_ID, action: 'BOOKING_CREATE' }), GRACE, NOW);
    expect(d.required).toBe(true);
    // Not ADMIN: an Admin releasing their own kind of request is no control.
    expect(d.approvers).toEqual(['CEO']);
  });

  it('lets an Accountant post inside the window and holds anything older', () => {
    expect(decideApproval(ctx({ effectiveDate: '2026-08-13' }), GRACE, NOW).required).toBe(false);
    const held = decideApproval(ctx({ effectiveDate: '2026-06-30' }), GRACE, NOW);
    expect(held.required).toBe(true);
    expect(held.approvers).toEqual(['ADMIN', 'CEO']);
    expect(held.reason).toContain('2026-06-30');
  });

  it('lets Sales sell directly but holds a cancellation', () => {
    const sell = decideApproval(ctx({ role: 'SALES', action: 'BOOKING_CREATE' }), GRACE, NOW);
    expect(sell.required).toBe(false);

    const cancel = decideApproval(
      ctx({ role: 'SALES', action: 'BOOKING_CANCEL', originalAuthorId: ACCOUNTANT_ID }), GRACE, NOW);
    expect(cancel.required).toBe(true);
  });
});

describe('correcting an entry', () => {
  const reverse = (over = {}) =>
    decideApproval(ctx({ action: 'VOUCHER_REVERSE', originalAuthorId: ACCOUNTANT_ID, ...over }), GRACE, NOW);

  it('lets an Accountant undo their own recent slip directly', () => {
    expect(reverse({ effectiveDate: '2026-08-18' }).required).toBe(false);
  });

  it('holds it once the original is older than the window', () => {
    const d = reverse({ effectiveDate: '2026-05-01' });
    expect(d.required).toBe(true);
    expect(d.reason).toContain('older than the correction window');
  });

  it('holds it when the entry was posted by someone else', () => {
    const d = reverse({ originalAuthorId: 999, effectiveDate: '2026-08-18' });
    expect(d.required).toBe(true);
    expect(d.reason).toContain('someone else');
  });

  it('holds it when the original author is unknown', () => {
    // An unattributed voucher must not be treated as "mine" by default.
    expect(reverse({ originalAuthorId: null, effectiveDate: NOW }).required).toBe(true);
  });

  it('does not extend the self-correction rule to Sales', () => {
    expect(reverse({ role: 'SALES', effectiveDate: NOW }).required).toBe(true);
  });
});

describe('nobody decides their own request', () => {
  const held = { approvers: ['ADMIN', 'CEO'] as const };

  it('accepts an Admin deciding an Accountant request', () => {
    expect(canDecide({ approvers: [...held.approvers] }, { id: ADMIN_ID, role: 'ADMIN' }, ACCOUNTANT_ID)).toBe(true);
  });

  it('refuses the requester even when their role is an approver', () => {
    expect(canDecide({ approvers: [...held.approvers] }, { id: ADMIN_ID, role: 'ADMIN' }, ADMIN_ID)).toBe(false);
    expect(canDecide({ approvers: ['CEO'] }, { id: CEO_ID, role: 'CEO' }, CEO_ID)).toBe(false);
  });

  it('refuses a role that is not an approver for this request', () => {
    expect(canDecide({ approvers: ['CEO'] }, { id: ADMIN_ID, role: 'ADMIN' }, ADMIN_ID + 1)).toBe(false);
  });
});
