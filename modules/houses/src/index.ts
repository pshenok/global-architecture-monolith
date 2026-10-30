/**
 * Public API of the houses module (ADR-0002): the only file other modules and the app
 * import. Everything else in src/ is private to the module.
 */
export { HOUSE_DELETED } from './contracts/house-events.ts';
export { HousesModule } from './houses.module.ts';
export { HOUSES_MIGRATIONS } from './migrations.ts';
export { type HouseSummary, HousesApi } from './transport/api/houses.api.ts';
