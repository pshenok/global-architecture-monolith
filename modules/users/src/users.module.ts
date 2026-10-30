import { EventsModule } from '@gam/platform';
import { Module } from '@nestjs/common';
import { UserEvents } from './application/ports/user-events.ts';
import { UserService } from './application/user.service.ts';
import { UserRepository } from './domain/user.repository.ts';
import { OutboxUserEvents } from './infrastructure/events/outbox-user-events.ts';
import { DrizzleUserRepository } from './infrastructure/persistence/drizzle-user.repository.ts';
import { UsersApi } from './transport/api/users.api.ts';
import { UsersIdentityResolver } from './transport/api/users-identity.resolver.ts';
import { UsersController } from './transport/http/users.controller.ts';

/**
 * The users module: accounts, logins and platform roles. Composition root: the only place
 * where its ports are bound to adapters. Other modules import it for UsersApi only.
 */
@Module({
  imports: [EventsModule.forFeature({ module: 'users', publish: true })],
  controllers: [UsersController],
  providers: [
    UserService,
    { provide: UserRepository, useClass: DrizzleUserRepository },
    { provide: UserEvents, useClass: OutboxUserEvents },
    UsersApi,
    UsersIdentityResolver,
  ],
  exports: [UsersApi, UsersIdentityResolver],
})
export class UsersModule {}
