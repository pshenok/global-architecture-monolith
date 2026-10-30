import { NotFoundError, PermissionDeniedError, PreconditionFailedError } from '@gam/kernel';

export const houseNotFound = (id: string) =>
  new NotFoundError('HOUSE_NOT_FOUND', `house ${id} not found`, { houseId: id });

export const ownerNotFound = (ownerId: string) =>
  new PreconditionFailedError('HOUSE_OWNER_NOT_FOUND', `owner ${ownerId} does not exist`, {
    ownerId,
  });

/** The house is public, so a stranger learns nothing new from a 403. */
export const housePermissionDenied = (id: string) =>
  new PermissionDeniedError('HOUSE_PERMISSION_DENIED', `only the owner may change house ${id}`, {
    houseId: id,
  });
