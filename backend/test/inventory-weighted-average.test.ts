import { describe, expect, it } from 'vitest';
import { valueWeightedAverageIssue } from '../src/modules/inventory/inventory.service';

describe('weighted-average stock issue valuation', () => {
  it('consumes the exact remaining value on the final issue', () => {
    // 10 @ 100 + 5 @ 200 = 15 units / 2,000.00. Valuing the issue from
    // the aggregate position keeps the remaining three units at 400.00.
    const first = valueWeightedAverageIssue({ quantity: 15, value: 2000 }, 12);
    expect(first).toEqual({ unitCost: 133.33, value: 1600 });

    const final = valueWeightedAverageIssue({ quantity: 3, value: 400 }, 3);
    expect(final).toEqual({ unitCost: 133.33, value: 400 });
    expect(2000 - first.value - final.value).toBe(0);
  });

  it('keeps partial issues at paisa precision', () => {
    expect(valueWeightedAverageIssue({ quantity: 3, value: 400.04 }, 1))
      .toEqual({ unitCost: 133.35, value: 133.35 });
  });
});
