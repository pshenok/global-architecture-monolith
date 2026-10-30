/**
 * Operator entry of the users module (`@gam/users/ops`): what the app's role CLI runs
 * against the database, outside any request. Not for other modules.
 */
export { changedBy, changeRole, parseRoleChange, type RoleChange } from './ops/role-change.ts';
