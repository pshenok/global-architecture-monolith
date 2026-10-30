import { EventsModule } from '@gam/platform';
import { UsersModule } from '@gam/users';
import { Module } from '@nestjs/common';
import { HouseService } from './application/house.service.ts';
import { HouseEvents } from './application/ports/house-events.ts';
import { UserDirectory } from './application/ports/user-directory.ts';
import { HouseRepository } from './domain/house.repository.ts';
import { OutboxHouseEvents } from './infrastructure/events/outbox-house-events.ts';
import { DrizzleHouseRepository } from './infrastructure/persistence/drizzle-house.repository.ts';
import { UsersApiDirectory } from './infrastructure/users/users-api-directory.ts';
import { HousesApi } from './transport/api/houses.api.ts';
import { UserEventsConsumer } from './transport/events/user-events.consumer.ts';
import { HousesController } from './transport/http/houses.controller.ts';

/**
 * The houses module: the catalogue of houses guests can book. Composition root: the only
 * place where its ports are bound to adapters. Depends on users (UsersApi, its events).
 */
@Module({
  imports: [
    UsersModule,
    EventsModule.forFeature({ module: 'houses', publish: true, consumers: [UserEventsConsumer] }),
  ],
  controllers: [HousesController],
  providers: [
    HouseService,
    { provide: HouseRepository, useClass: DrizzleHouseRepository },
    { provide: UserDirectory, useClass: UsersApiDirectory },
    { provide: HouseEvents, useClass: OutboxHouseEvents },
    HousesApi,
    UserEventsConsumer,
  ],
  exports: [HousesApi],
})
export class HousesModule {}
