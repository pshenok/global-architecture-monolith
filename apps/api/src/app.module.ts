import { BookingsModule } from '@gam/bookings';
import { HousesModule } from '@gam/houses';
import { PlatformModule } from '@gam/platform';
import { UsersIdentityResolver, UsersModule } from '@gam/users';
import { Module } from '@nestjs/common';
import { ConfigSchema } from './config.ts';

/**
 * The monolith: the platform and every feature module, in one process. Composition root
 * of the app: the only place that binds the platform's IdentityResolver to the module
 * that owns users, and that lists the modules the app serves.
 */
@Module({
  imports: [
    PlatformModule.forRoot({
      name: 'api',
      config: ConfigSchema,
      identities: { imports: [UsersModule], useExisting: UsersIdentityResolver },
    }),
    UsersModule,
    HousesModule,
    BookingsModule,
    // pnpm new:module adds feature modules above this line
  ],
})
export class AppModule {}
