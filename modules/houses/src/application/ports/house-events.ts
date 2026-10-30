import type { House } from '../../domain/house.ts';

/** Facts about houses that other modules react to (ADR-0005). */
export abstract class HouseEvents {
  /** Records that a house was deleted; call it inside the deleting UnitOfWork. */
  abstract deleted(house: House): Promise<void>;
}
