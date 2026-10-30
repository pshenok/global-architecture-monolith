import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors.ts';
import { money, multiplyMoney } from './money.ts';

describe('money', () => {
  it('accepts ISO currency codes and integer minor units', () => {
    expect(money('USD', 12_550)).toEqual({ currencyCode: 'USD', amountMinor: 12_550 });
  });

  it('rejects bad codes, fractions and negatives with field paths', () => {
    expect(() => money('usd', 1)).toThrow(ValidationError);
    expect(() => money('USD', 1.5, 'nightlyPrice')).toThrow(/nightlyPrice/);
    expect(() => money('USD', -1)).toThrow(ValidationError);
  });

  it('multiplies by a quantity and refuses overflow', () => {
    expect(multiplyMoney(money('EUR', 9_900), 3)).toEqual({
      currencyCode: 'EUR',
      amountMinor: 29_700,
    });
    expect(() => multiplyMoney(money('EUR', Number.MAX_SAFE_INTEGER), 2)).toThrow(ValidationError);
  });
});
