import { HOUSE_DELETED } from '@gam/houses';
import { currentService, type EventPayload, OnEvent } from '@gam/platform';
import { Injectable } from '@nestjs/common';
import { BookingService } from '../../application/booking.service.ts';

/** Reactions to the houses module's events: one use case per event, no business logic here. */
@Injectable()
export class HouseEventsConsumer {
  constructor(private readonly bookings: BookingService) {}

  /** Covers the host's stays too: a deleted host's houses each announce their deletion. */
  @OnEvent(HOUSE_DELETED)
  async houseDeleted(event: EventPayload<typeof HOUSE_DELETED>): Promise<void> {
    await this.bookings.cancelOpenStaysOfHouse(currentService(), event.houseId);
  }
}
