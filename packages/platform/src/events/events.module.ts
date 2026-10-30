import { Clock, IdGenerator } from '@gam/kernel';
import { type DynamicModule, Global, Injectable, Module, type Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { DbContext } from '../database/db-context.ts';
import { EventDispatcher } from './dispatcher.ts';
import { Outbox } from './outbox.ts';
import {
  addToCatalog,
  type EventFeature,
  type EventFeatureOptions,
  EventRegistry,
  eventFeatureOf,
} from './registry.ts';

/** The registry and the dispatcher, once per app (PlatformModule imports it). */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [EventRegistry, EventDispatcher],
  exports: [EventRegistry, EventDispatcher],
})
export class EventsCoreModule {}

const FEATURE = Symbol('EVENT_FEATURE');

/** Registers one module's feature with the app's registry when the module is instantiated. */
@Injectable()
class FeatureRegistration {
  constructor(registry: EventRegistry, feature: EventFeature) {
    registry.register(feature);
  }
}

/**
 * Asynchronous events between modules (ADR-0005). A module never sees how events are
 * stored or delivered: it records them with `Outbox.add` inside `UnitOfWork.run`, and
 * handles other modules' events with `@OnEvent` methods.
 *
 *   EventsModule.forFeature({ module: 'houses', publish: true, consumers: [UserEventsConsumer] })
 *
 * in the module's imports; the consumers are also in its providers.
 */
@Module({})
export class EventsModule {
  static forFeature(options: EventFeatureOptions): DynamicModule {
    const feature = eventFeatureOf(options);
    addToCatalog(feature);
    const providers: Provider[] = [
      { provide: FEATURE, useValue: feature },
      {
        provide: FeatureRegistration,
        inject: [EventRegistry, FEATURE],
        useFactory: (registry: EventRegistry, value: EventFeature) =>
          new FeatureRegistration(registry, value),
      },
    ];
    if (feature.publish) {
      providers.push({
        provide: Outbox,
        inject: [DbContext, IdGenerator, Clock, EventRegistry],
        useFactory: (db: DbContext, ids: IdGenerator, clock: Clock, registry: EventRegistry) =>
          new Outbox(db, ids, clock, registry, feature.module),
      });
    }
    return {
      module: EventsModule,
      providers,
      exports: feature.publish ? [Outbox] : [],
    };
  }
}
