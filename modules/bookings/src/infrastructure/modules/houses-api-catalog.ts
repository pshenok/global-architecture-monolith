import { HousesApi } from '@gam/houses';
import { Injectable } from '@nestjs/common';
import { HouseCatalog } from '../../application/ports/house-catalog.ts';
import type { HouseTerms } from '../../domain/booking.ts';

/**
 * HouseCatalog backed by the houses module's public API (anti-corruption layer: maps its
 * HouseSummary to our HouseTerms).
 */
@Injectable()
export class HousesApiCatalog extends HouseCatalog {
  constructor(private readonly houses: HousesApi) {
    super();
  }

  async findTerms(houseId: string): Promise<HouseTerms | null> {
    const house = await this.houses.findHouse(houseId);
    if (!house) return null;
    return {
      maxGuests: house.maxGuests,
      nightlyPrice: { ...house.nightlyPrice },
      ownerId: house.ownerId,
    };
  }
}
