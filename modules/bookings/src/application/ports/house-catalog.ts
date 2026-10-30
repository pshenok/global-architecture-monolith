import type { HouseTerms } from '../../domain/booking.ts';

/** What the bookings module needs to know about houses. */
export abstract class HouseCatalog {
  /** Current booking terms of a house, or null when it does not exist. */
  abstract findTerms(houseId: string): Promise<HouseTerms | null>;
}
