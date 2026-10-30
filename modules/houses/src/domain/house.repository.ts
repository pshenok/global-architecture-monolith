import type { Page, PageRequest } from '@gam/kernel';
import type { House } from './house.ts';

export interface HouseFilter {
  readonly ownerId?: string | undefined;
  /** Case-insensitive exact city match. */
  readonly city?: string | undefined;
}

/** Persistence port for House. */
export abstract class HouseRepository {
  /** `forUpdate` locks the row until the surrounding UnitOfWork ends. */
  abstract findById(id: string, options?: { forUpdate?: boolean }): Promise<House | null>;
  /** Newest first. */
  abstract list(filter: HouseFilter, page: PageRequest): Promise<Page<House>>;
  abstract insert(house: House): Promise<void>;
  abstract update(house: House): Promise<void>;
  /** Returns false when nothing was deleted. */
  abstract delete(id: string): Promise<boolean>;
  /** Deletes every house of an owner and returns them as they were. */
  abstract deleteByOwner(ownerId: string): Promise<readonly House[]>;
}
