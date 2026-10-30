/**
 * Public API of the bookings module (ADR-0002): the only file the app imports. Nothing
 * else depends on bookings, so it exposes its Nest module and its migrations only.
 */
export { BookingsModule } from './bookings.module.ts';
export { BOOKINGS_MIGRATIONS } from './migrations.ts';
