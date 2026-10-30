import { pageOf } from '@gam/platform';
import { z } from 'zod';
import type { User } from '../../domain/user.ts';

/** Registration: the identity and the email come from the bearer token, never from the body. */
export const RegisterUserBody = z
  .object({
    fullName: z.string().trim().min(1).max(200),
  })
  .meta({ id: 'RegisterUserBody' });

export const UpdateUserBody = z
  .object({
    fullName: z.string().trim().min(1).max(200).optional(),
  })
  .meta({ id: 'UpdateUserBody' });

/** `me` (the signed-in user) or a user id, lowercased like the ids the API returns. */
export const UserIdParam = z.union([z.literal('me'), z.uuid().toLowerCase()], {
  message: 'must be "me" or a UUID',
});

export const UserView = z
  .object({
    id: z.uuid(),
    email: z.email().nullable().describe('Null when the identity provider shared no email.'),
    fullName: z.string(),
    roles: z.array(z.string()).describe('Platform roles, e.g. "admin".'),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'User' });

export const UserPage = pageOf(UserView, 'UserPage');

/** Domain -> REST. */
export function toUserView(user: User): z.output<typeof UserView> {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    roles: [...user.roles],
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
