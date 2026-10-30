import { defineEvent } from '@gam/platform';
import { z } from 'zod';

/**
 * A user's account and logins are gone (ADR-0005). Its houses and bookings are cleaned up
 * by the modules that own them. Part of the module's public API: evolve it compatibly.
 */
export const USER_DELETED = defineEvent(
  'users.v1.UserDeletedEvent',
  z.object({
    /** The deleted user's id. */
    userId: z.uuid(),
  }),
);
