import { Module } from '@nestjs/common';
import { SampleItemService } from './application/sample-item.service.ts';
import { SampleItemRepository } from './domain/sample-item.repository.ts';
import { DrizzleSampleItemRepository } from './infrastructure/persistence/drizzle-sample-item.repository.ts';
import { SampleItemsController } from './transport/http/sample-items.controller.ts';

/**
 * The sample items module. Composition root: the only place where its ports are bound to
 * adapters. When other modules need it, add a ModuleApi class in src/transport/api and
 * export it here and from src/index.ts; to publish or handle events, import
 * EventsModule.forFeature (the gam-service-communication skill).
 */
@Module({
  controllers: [SampleItemsController],
  providers: [
    SampleItemService,
    { provide: SampleItemRepository, useClass: DrizzleSampleItemRepository },
  ],
})
export class SampleItemsModule {}
