import { HousesModule } from '@gam/houses';
import { EventsModule } from '@gam/platform';
import { UsersModule } from '@gam/users';
import { Module } from '@nestjs/common';
import { BookingService } from './application/booking.service.ts';
import { HouseCatalog } from './application/ports/house-catalog.ts';
import { UserDirectory } from './application/ports/user-directory.ts';
import { BookingRepository } from './domain/booking.repository.ts';
import { HousesApiCatalog } from './infrastructure/modules/houses-api-catalog.ts';
import { UsersApiDirectory } from './infrastructure/modules/users-api-directory.ts';
import { DrizzleBookingRepository } from './infrastructure/persistence/drizzle-booking.repository.ts';
import { HouseEventsConsumer } from './transport/events/house-events.consumer.ts';
import { UserEventsConsumer } from './transport/events/user-events.consumer.ts';
import { BookingsController } from './transport/http/bookings.controller.ts';

/**
 * The bookings module: guests' stays in houses. Composition root: the only place where
 * its ports are bound to adapters. Depends on users and houses (their APIs and events);
 * nothing depends on it.
 */
@Module({
  imports: [
    UsersModule,
    HousesModule,
    EventsModule.forFeature({
      module: 'bookings',
      consumers: [HouseEventsConsumer, UserEventsConsumer],
    }),
  ],
  controllers: [BookingsController],
  providers: [
    BookingService,
    { provide: BookingRepository, useClass: DrizzleBookingRepository },
    { provide: UserDirectory, useClass: UsersApiDirectory },
    { provide: HouseCatalog, useClass: HousesApiCatalog },
    HouseEventsConsumer,
    UserEventsConsumer,
  ],
})
export class BookingsModule {}
