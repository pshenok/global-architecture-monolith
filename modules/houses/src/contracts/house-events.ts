import { defineEvent } from '@gam/platform';
import { z } from 'zod';

/**
 * A house is gone (ADR-0005): deleted by its owner or an admin, or with its owner's
 * account. Bookings cancels its open stays. Part of the module's public API: evolve it
 * compatibly.
 */
export const HOUSE_DELETED = defineEvent(
  'houses.v1.HouseDeletedEvent',
  z.object({
    houseId: z.uuid(),
    /** The owner (host) at the time of the delete. */
    ownerId: z.uuid(),
  }),
);
