/**
 * Public API of the users module (ADR-0002): the only file other modules and the app
 * import. Everything else in src/ is private to the module.
 */
export { USER_DELETED } from './contracts/user-events.ts';
export { USERS_MIGRATIONS } from './migrations.ts';
export { UsersApi } from './transport/api/users.api.ts';
export { UsersIdentityResolver } from './transport/api/users-identity.resolver.ts';
export { UsersModule } from './users.module.ts';
