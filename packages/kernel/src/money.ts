import { ValidationError } from './errors.ts';

/**
 * An amount in the minor unit of a currency (cents for USD). Integers only:
 * never use floating point for money.
 */
export interface Money {
  /** ISO 4217, e.g. "USD". */
  readonly currencyCode: string;
  /** Minor units, e.g. 12550 = 125.50 USD. */
  readonly amountMinor: number;
}

const CURRENCY = /^[A-Z]{3}$/;

/** Validates and returns a Money value. `field` names the input for error messages. */
export function money(currencyCode: string, amountMinor: number, field = 'money'): Money {
  const violations = [];
  if (!CURRENCY.test(currencyCode)) {
    violations.push({
      field: `${field}.currencyCode`,
      description: 'must be an ISO 4217 code like USD',
    });
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    violations.push({
      field: `${field}.amountMinor`,
      description: 'must be a non-negative integer',
    });
  }
  if (violations.length > 0) throw new ValidationError(`${field} is invalid`, violations);
  return Object.freeze({ currencyCode, amountMinor });
}

/** Multiplies an amount by a whole quantity (e.g. nights), guarding against overflow. */
export function multiplyMoney(value: Money, quantity: number): Money {
  const amountMinor = value.amountMinor * quantity;
  if (!Number.isSafeInteger(quantity) || quantity < 0 || !Number.isSafeInteger(amountMinor)) {
    throw new ValidationError('money amount out of range');
  }
  return Object.freeze({ currencyCode: value.currencyCode, amountMinor });
}
