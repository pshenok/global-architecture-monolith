import {
  Clock,
  IdGenerator,
  type Money,
  type Page,
  type PageRequest,
  type ServiceActor,
  UnitOfWork,
  type UserActor,
} from '@gam/kernel';
import { Injectable } from '@nestjs/common';
import { houseNotFound, ownerNotFound } from '../domain/house.errors.ts';
import { type HouseFilter, HouseRepository } from '../domain/house.repository.ts';
import { type Address, House, type HouseChanges } from '../domain/house.ts';
import { HouseEvents } from './ports/house-events.ts';
import { UserDirectory } from './ports/user-directory.ts';

export interface CreateHouseInput {
  readonly title: string;
  readonly description: string;
  readonly address: Address;
  readonly nightlyPrice: Money;
  readonly maxGuests: number;
}

/** Use cases of the houses module. */
@Injectable()
export class HouseService {
  constructor(
    private readonly houses: HouseRepository,
    private readonly users: UserDirectory,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly unitOfWork: UnitOfWork,
    private readonly events: HouseEvents,
  ) {}

  /**
   * Lists a house owned by the acting user. Validates the house first (cheap), then asks
   * the users module whether the owner's account still exists (before any transaction).
   */
  async create(actor: UserActor, input: CreateHouseInput): Promise<House> {
    const house = House.create(
      { id: this.ids.newId(), ownerId: actor.userId, ...input },
      this.clock.now(),
    );
    if (!(await this.users.stillExists(actor))) throw ownerNotFound(actor.userId);
    await this.houses.insert(house);
    return house;
  }

  async get(id: string): Promise<House> {
    const house = await this.houses.findById(id);
    if (!house) throw houseNotFound(id);
    return house;
  }

  list(filter: HouseFilter, page: PageRequest): Promise<Page<House>> {
    return this.houses.list(filter, page);
  }

  update(actor: UserActor, id: string, changes: HouseChanges): Promise<House> {
    return this.unitOfWork.run(async () => {
      const house = await this.houses.findById(id, { forUpdate: true });
      if (!house) throw houseNotFound(id);
      house.assertManageableBy(actor);
      house.update(changes, this.clock.now());
      await this.houses.update(house);
      return house;
    });
  }

  /**
   * Checks ownership under the row lock, so an ownership check and the delete cannot
   * interleave, and records HouseDeletedEvent with the delete (ADR-0005).
   */
  delete(actor: UserActor, id: string): Promise<void> {
    return this.unitOfWork.run(async () => {
      const house = await this.houses.findById(id, { forUpdate: true });
      if (!house) throw houseNotFound(id);
      house.assertManageableBy(actor);
      await this.houses.delete(id);
      await this.events.deleted(house);
    });
  }

  /**
   * Deletes every house of an owner whose account is gone, each with its
   * HouseDeletedEvent, in one transaction. Only the module itself reaches it (handling
   * UserDeletedEvent); running it again finds nothing left. Returns how many it deleted.
   */
  removeAllOf(_actor: ServiceActor, ownerId: string): Promise<number> {
    return this.unitOfWork.run(async () => {
      const removed = await this.houses.deleteByOwner(ownerId);
      for (const house of removed) await this.events.deleted(house);
      return removed.length;
    });
  }
}
