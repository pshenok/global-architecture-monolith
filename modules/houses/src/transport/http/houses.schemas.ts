import { MoneyView, pageOf } from '@gam/platform';
import { z } from 'zod';
import type { House } from '../../domain/house.ts';

const Address = z
  .object({
    line1: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(100),
    countryCode: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .describe('ISO 3166-1 alpha-2, e.g. UA'),
  })
  .meta({ id: 'Address' });

const Price = z
  .object({
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .describe('ISO 4217, e.g. USD'),
    amountMinor: z.number().int().positive().describe('Price per night in minor units'),
  })
  .meta({ id: 'NightlyPrice' });

/** The owner is the signed-in user; it is never taken from the body. */
export const CreateHouseBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5000).default(''),
    address: Address,
    nightlyPrice: Price,
    maxGuests: z.number().int().min(1).max(50),
  })
  .meta({ id: 'CreateHouseBody' });

export const UpdateHouseBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    address: Address.optional().describe('Replaces the whole address'),
    nightlyPrice: Price.optional(),
    maxGuests: z.number().int().min(1).max(50).optional(),
  })
  .meta({ id: 'UpdateHouseBody' });

export const HouseQuery = z.object({
  ownerId: z.uuid().toLowerCase().optional(),
  city: z.string().trim().min(1).max(100).optional().describe('Case-insensitive exact match'),
});

export const HouseView = z
  .object({
    id: z.uuid(),
    ownerId: z.uuid(),
    title: z.string(),
    description: z.string(),
    address: z.object({ line1: z.string(), city: z.string(), countryCode: z.string() }),
    nightlyPrice: MoneyView,
    maxGuests: z.number().int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'House' });

export const HousePage = pageOf(HouseView, 'HousePage');

/** Domain -> REST. */
export function toHouseView(house: House): z.output<typeof HouseView> {
  return {
    id: house.id,
    ownerId: house.ownerId,
    title: house.title,
    description: house.description,
    address: { ...house.address },
    nightlyPrice: { ...house.nightlyPrice },
    maxGuests: house.maxGuests,
    createdAt: house.createdAt.toISOString(),
    updatedAt: house.updatedAt.toISOString(),
  };
}
