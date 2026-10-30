import {
  Clock,
  IdGenerator,
  type Page,
  type PageRequest,
  toPage,
  UnitOfWork,
  type UserActor,
} from '@gam/kernel';
import { HouseEvents } from '../src/application/ports/house-events.ts';
import { UserDirectory } from '../src/application/ports/user-directory.ts';
import { type HouseFilter, HouseRepository } from '../src/domain/house.repository.ts';
import { House, type HouseState } from '../src/domain/house.ts';

/**
 * "YYYY-MM-DD" n days after `from` (UTC). In use-case tests pass `clock.now()` as `from`,
 * so dates stay consistent with the FixedClock instead of the real date.
 */
export function day(n: number, from: Date = new Date()): string {
  const base = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
}

export class SequentialIds extends IdGenerator {
  private next = 0;

  newId(): string {
    this.next += 1;
    return `01900000-0000-7000-8000-${String(this.next).padStart(12, '0')}`;
  }
}

export class FixedClock extends Clock {
  constructor(public current = new Date('2026-01-01T00:00:00.000Z')) {
    super();
  }

  now(): Date {
    return this.current;
  }
}

export class PassThroughUnitOfWork extends UnitOfWork {
  run<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}

/** UserDirectory that knows a fixed set of user ids. */
export class FakeUserDirectory extends UserDirectory {
  constructor(public readonly known = new Set<string>()) {
    super();
  }

  async stillExists(actor: UserActor): Promise<boolean> {
    return this.known.has(actor.userId);
  }
}

export class InMemoryHouseRepository extends HouseRepository {
  readonly rows = new Map<string, HouseState>();

  async findById(id: string): Promise<House | null> {
    const state = this.rows.get(id);
    return state ? House.restore(state) : null;
  }

  async list(filter: HouseFilter, { limit, after }: PageRequest): Promise<Page<House>> {
    const rows = [...this.rows.values()]
      .filter((s) => after === null || s.id < after)
      .filter((s) => !filter.ownerId || s.ownerId === filter.ownerId)
      .filter((s) => !filter.city || s.address.city.toLowerCase() === filter.city.toLowerCase())
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit + 1)
      .map((s) => House.restore(s));
    return toPage(rows, limit);
  }

  async insert(house: House): Promise<void> {
    this.rows.set(house.id, house.toState());
  }

  async update(house: House): Promise<void> {
    this.rows.set(house.id, house.toState());
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async deleteByOwner(ownerId: string): Promise<readonly House[]> {
    const owned = [...this.rows.values()].filter((s) => s.ownerId === ownerId);
    for (const state of owned) this.rows.delete(state.id);
    return owned.map((s) => House.restore(s));
  }
}

/** Records the events a use case raised, in order. */
export class RecordingHouseEvents extends HouseEvents {
  readonly deletedHouses: string[] = [];

  async deleted(house: House): Promise<void> {
    this.deletedHouses.push(house.id);
  }
}

export const OWNER_ID = '01900000-0000-7000-8000-0000000000aa';

/** Use-case input of CreateHouse (the owner is the acting user). */
export const houseInput = (overrides: Record<string, unknown> = {}) => ({
  title: 'Sea view loft',
  description: 'Two rooms by the sea',
  address: { line1: '1 Beach St', city: 'Odesa', countryCode: 'UA' },
  nightlyPrice: { currencyCode: 'USD', amountMinor: 12_000 },
  maxGuests: 4,
  ...overrides,
});
