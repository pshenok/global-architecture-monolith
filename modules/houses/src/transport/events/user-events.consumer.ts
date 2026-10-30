import { currentService, type EventPayload, OnEvent } from '@gam/platform';
import { USER_DELETED } from '@gam/users';
import { Injectable } from '@nestjs/common';
import { HouseService } from '../../application/house.service.ts';

/** Reactions to the users module's events: one use case per event, no business logic here. */
@Injectable()
export class UserEventsConsumer {
  constructor(private readonly houses: HouseService) {}

  /** The owner's account is gone: so are its houses (each announces HouseDeletedEvent). */
  @OnEvent(USER_DELETED)
  async userDeleted(event: EventPayload<typeof USER_DELETED>): Promise<void> {
    await this.houses.removeAllOf(currentService(), event.userId);
  }
}
