import { Outbox } from '@gam/platform';
import { Injectable } from '@nestjs/common';
import { HouseEvents } from '../../application/ports/house-events.ts';
import { HOUSE_DELETED } from '../../contracts/house-events.ts';
import type { House } from '../../domain/house.ts';

/** HouseEvents through the transactional outbox: delivered once the change commits. */
@Injectable()
export class OutboxHouseEvents extends HouseEvents {
  constructor(private readonly outbox: Outbox) {
    super();
  }

  deleted(house: House): Promise<void> {
    return this.outbox.add(HOUSE_DELETED, house.id, { houseId: house.id, ownerId: house.ownerId });
  }
}
