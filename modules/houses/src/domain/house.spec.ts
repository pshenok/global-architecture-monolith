import { ANONYMOUS, PermissionDeniedError, ValidationError } from '@gam/kernel';
import { adminActor, userActor } from '@gam/kernel/testing';
import { describe, expect, it } from 'vitest';
import { houseInput, OWNER_ID } from '../../test/fakes.ts';
import { House } from './house.ts';

const now = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-02T00:00:00.000Z');

describe('House', () => {
  it('normalizes the address and keeps money as integer minor units', () => {
    const house = House.create(
      {
        id: 'h1',
        ownerId: OWNER_ID,
        ...houseInput({ address: { line1: ' 1 Beach St ', city: ' Odesa ', countryCode: 'ua' } }),
      },
      now,
    );
    expect(house.address).toEqual({ line1: '1 Beach St', city: 'Odesa', countryCode: 'UA' });
    expect(house.nightlyPrice).toEqual({ currencyCode: 'USD', amountMinor: 12_000 });
  });

  it.each([
    [{ title: '' }, 'title'],
    [{ maxGuests: 0 }, 'maxGuests'],
    [{ maxGuests: 51 }, 'maxGuests'],
    [{ nightlyPrice: { currencyCode: 'USD', amountMinor: 0 } }, 'nightlyPrice.amountMinor'],
    [{ nightlyPrice: { currencyCode: 'usd', amountMinor: 100 } }, 'nightlyPrice.currencyCode'],
    [{ address: { line1: 'x', city: 'y', countryCode: 'UKR' } }, 'address.countryCode'],
  ])('rejects %o on field %s', (overrides, field) => {
    try {
      House.create({ id: 'h1', ownerId: OWNER_ID, ...houseInput(overrides) }, now);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).violations[0]?.field).toBe(field);
    }
  });

  it('updates only what changed', () => {
    const house = House.create({ id: 'h1', ownerId: OWNER_ID, ...houseInput() }, now);
    house.update({ maxGuests: 4 }, later);
    expect(house.updatedAt).toEqual(now);
    house.update({ maxGuests: 6, title: 'Bigger loft' }, later);
    expect(house.toState()).toMatchObject({ maxGuests: 6, title: 'Bigger loft', updatedAt: later });
  });

  it('may be managed by its owner and by admins only', () => {
    const house = House.create({ id: 'h1', ownerId: OWNER_ID, ...houseInput() }, now);
    expect(() => house.assertManageableBy(userActor(OWNER_ID))).not.toThrow();
    expect(() => house.assertManageableBy(adminActor('someone-else'))).not.toThrow();
    for (const stranger of [userActor('someone-else'), ANONYMOUS]) {
      expect(() => house.assertManageableBy(stranger)).toThrow(PermissionDeniedError);
    }
  });
});
