import { type Money, NotFoundError } from '@gam/kernel';
import { ModuleApi } from '@gam/platform';
import { Injectable } from '@nestjs/common';
import { HouseService } from '../../application/house.service.ts';

/** A house as other modules see it. */
export interface HouseSummary {
  readonly id: string;
  readonly ownerId: string;
  readonly maxGuests: number;
  readonly nightlyPrice: Money;
}

/**
 * What other modules may ask the houses module (its public API, ADR-0002). In-process
 * calls, never inside the caller's transaction (ModuleApi).
 */
@ModuleApi()
@Injectable()
export class HousesApi {
  constructor(private readonly houses: HouseService) {}

  /** A house of the catalogue, or null when there is none with this id. */
  async findHouse(id: string): Promise<HouseSummary | null> {
    try {
      const house = await this.houses.get(id);
      return {
        id: house.id,
        ownerId: house.ownerId,
        maxGuests: house.maxGuests,
        nightlyPrice: { ...house.nightlyPrice },
      };
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }
}
