/**
 * Public API of the sample items module (ADR-0002): the only file other modules and the
 * app import. Everything else in src/ is private to the module.
 */
export { SAMPLE_ITEMS_MIGRATIONS } from './migrations.ts';
export { SampleItemsModule } from './sample-items.module.ts';
