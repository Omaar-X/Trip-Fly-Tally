import { describe, expect, it } from 'vitest';
import {
  CEO_LOAN_LEDGER, classifyCeoLoanMovement, classifyPaymentNarration,
} from '../src/modules/migration/expenseRules';

describe('Phase 4 handoff decisions Q106-Q107', () => {
  it('classifies only explicit Rajib loan advances as the CEO loan asset', () => {
    expect(classifyPaymentNarration('LOAN PAID TO RAZIB SIR'))
      .toMatchObject({ kind: 'LOAN', ledger: CEO_LOAN_LEDGER });
    expect(classifyCeoLoanMovement('LOAN PAID TO RAZIB SIR')).toBe('ADVANCE');
  });

  it('recognises explicit repayment evidence against the same ledger', () => {
    expect(classifyCeoLoanMovement('LOAN REPAYMENT RECEIVED FROM RAJIB SIR')).toBe('REPAYMENT');
  });

  it('does not turn an ordinary Rajib transaction into a loan', () => {
    expect(classifyCeoLoanMovement('RAJIB SIR PERSONAL CARD PAYMENT')).toBeNull();
    expect(classifyPaymentNarration('RAJIB SIR PERSONAL CARD PAYMENT').kind).toBe('UNCLASSIFIED');
  });
});
