import { currentService, type EventPayload, OnEvent } from '@gam/platform';
import { USER_DELETED } from '@gam/users';
import { Injectable } from '@nestjs/common';
import { BookingService } from '../../application/booking.service.ts';

/** Reactions to the users module's events: one use case per event, no business logic here. */
@Injectable()
export class UserEventsConsumer {
  constructor(private readonly bookings: BookingService) {}

  /** The guest side only: stays the user hosts go with its houses (HouseDeletedEvent). */
  @OnEvent(USER_DELETED)
  async userDeleted(event: EventPayload<typeof USER_DELETED>): Promise<void> {
    await this.bookings.cancelOpenStaysOfGuest(currentService(), event.userId);
  }
}
