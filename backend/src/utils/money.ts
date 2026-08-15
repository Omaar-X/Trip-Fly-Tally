/**
 * Money helpers. All accounting comparisons are done in integer cents (poisha)
 * so floating point can never break the debit == credit invariant.
 */
export const toCents = (amount: number): number => Math.round(Number(amount) * 100);
export const fromCents = (cents: number): number => Math.round(cents) / 100;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Quantities, not money. Stock and invoice lines are DECIMAL(x,3), so a
 * quantity must be rounded to the precision it will be STORED at before any
 * amount is derived from it — otherwise the stored quantity times the stored
 * rate does not equal the stored amount and the document does not foot.
 */
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export const sumCents = (amounts: number[]): number =>
  amounts.reduce((acc, a) => acc + toCents(a), 0);
