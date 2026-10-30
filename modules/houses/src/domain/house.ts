import { type Actor, isAdmin, type Money, money, ValidationError } from '@gam/kernel';
import { housePermissionDenied } from './house.errors.ts';

export interface Address {
  readonly line1: string;
  readonly city: string;
  /** ISO 3166-1 alpha-2, e.g. "UA". */
  readonly countryCode: string;
}

/** Persisted state of a House. */
export interface HouseState {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly description: string;
  readonly address: Address;
  readonly nightlyPrice: Money;
  readonly maxGuests: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface HouseChanges {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly address?: Address | undefined;
  readonly nightlyPrice?: Money | undefined;
  readonly maxGuests?: number | undefined;
}

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 5000;
export const MAX_GUESTS_LIMIT = 50;

function invalid(field: string, description: string): ValidationError {
  return new ValidationError(`${field} ${description}`, [{ field, description }]);
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > TITLE_MAX)
    throw invalid('title', `must be 1..${TITLE_MAX} characters`);
  return trimmed;
}

function normalizeDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length > DESCRIPTION_MAX)
    throw invalid('description', `must be at most ${DESCRIPTION_MAX} characters`);
  return trimmed;
}

function normalizeAddress(address: Address): Address {
  const line1 = address.line1.trim();
  const city = address.city.trim();
  const countryCode = address.countryCode.trim().toUpperCase();
  if (line1.length === 0 || line1.length > 200)
    throw invalid('address.line1', 'must be 1..200 characters');
  if (city.length === 0 || city.length > 100)
    throw invalid('address.city', 'must be 1..100 characters');
  if (!/^[A-Z]{2}$/.test(countryCode))
    throw invalid('address.countryCode', 'must be an ISO 3166-1 alpha-2 code');
  return Object.freeze({ line1, city, countryCode });
}

function normalizePrice(price: Money): Money {
  const value = money(price.currencyCode, price.amountMinor, 'nightlyPrice');
  if (value.amountMinor === 0) throw invalid('nightlyPrice.amountMinor', 'must be greater than 0');
  return value;
}

function normalizeMaxGuests(maxGuests: number): number {
  if (!Number.isInteger(maxGuests) || maxGuests < 1 || maxGuests > MAX_GUESTS_LIMIT) {
    throw invalid('maxGuests', `must be 1..${MAX_GUESTS_LIMIT}`);
  }
  return maxGuests;
}

/** House aggregate: a property guests can book. */
export class House {
  private constructor(private state: HouseState) {}

  static create(
    input: {
      id: string;
      ownerId: string;
      title: string;
      description: string;
      address: Address;
      nightlyPrice: Money;
      maxGuests: number;
    },
    now: Date,
  ): House {
    return new House({
      id: input.id,
      ownerId: input.ownerId,
      title: normalizeTitle(input.title),
      description: normalizeDescription(input.description),
      address: normalizeAddress(input.address),
      nightlyPrice: normalizePrice(input.nightlyPrice),
      maxGuests: normalizeMaxGuests(input.maxGuests),
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(state: HouseState): House {
    return new House({ ...state });
  }

  /** Only the owner, or an admin, may change or delete a house. */
  assertManageableBy(actor: Actor): void {
    const isOwner = actor.kind === 'user' && actor.userId === this.state.ownerId;
    if (!isOwner && !isAdmin(actor)) throw housePermissionDenied(this.state.id);
  }

  get id(): string {
    return this.state.id;
  }

  get ownerId(): string {
    return this.state.ownerId;
  }

  get title(): string {
    return this.state.title;
  }

  get description(): string {
    return this.state.description;
  }

  get address(): Address {
    return this.state.address;
  }

  get nightlyPrice(): Money {
    return this.state.nightlyPrice;
  }

  get maxGuests(): number {
    return this.state.maxGuests;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  /** Applies the given changes; fields left undefined stay as they are. */
  update(changes: HouseChanges, now: Date): void {
    const next: HouseState = {
      ...this.state,
      title: changes.title === undefined ? this.state.title : normalizeTitle(changes.title),
      description:
        changes.description === undefined
          ? this.state.description
          : normalizeDescription(changes.description),
      address:
        changes.address === undefined ? this.state.address : normalizeAddress(changes.address),
      nightlyPrice:
        changes.nightlyPrice === undefined
          ? this.state.nightlyPrice
          : normalizePrice(changes.nightlyPrice),
      maxGuests:
        changes.maxGuests === undefined
          ? this.state.maxGuests
          : normalizeMaxGuests(changes.maxGuests),
    };
    if (
      JSON.stringify({ ...next, updatedAt: null }) ===
      JSON.stringify({ ...this.state, updatedAt: null })
    )
      return;
    this.state = { ...next, updatedAt: now };
  }

  toState(): HouseState {
    return { ...this.state };
  }
}
