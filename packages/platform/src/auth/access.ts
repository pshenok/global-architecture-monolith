import { ApiExtension } from '@nestjs/swagger';

/**
 * Access policy of an HTTP route (ADR-0004). Every route handler declares exactly one;
 * an app with an undeclared route refuses to start, and the AuthGuard refuses a route it
 * did not record at boot.
 *
 *   @Access.user()                                     a registered user
 *   @Access.admin()                                    a user with the admin role
 *   @Access.identity()                                 a verified login without a user yet (registration)
 *   @Access.public('world-readable catalogue')         anyone; the handler never sees who
 *   @Access.public('probes', { ignoreToken: true })    ... without even reading a token
 *
 * Every route that needs no registered user is listed in security/public-endpoints.json.
 */
export const ACCESS_POLICY = 'gam:access-policy';

/** OpenAPI extension that marks an operation as not needing a token (removed from the document). */
export const PUBLIC_EXTENSION = 'x-gam-public';

export type AccessPolicy =
  | { readonly kind: 'public'; readonly reason: string; readonly ignoreToken: boolean }
  | { readonly kind: 'user' | 'admin' | 'identity' };

function declare(policy: AccessPolicy): MethodDecorator {
  return (target, key, descriptor) => {
    const handler = descriptor.value as object | undefined;
    if (typeof handler !== 'function') throw new TypeError('@Access decorates methods');
    if (Reflect.hasMetadata(ACCESS_POLICY, handler)) {
      throw new TypeError(`${String(key)} declares more than one @Access policy`);
    }
    Reflect.defineMetadata(ACCESS_POLICY, Object.freeze(policy), handler);
    if (policy.kind === 'public') ApiExtension(PUBLIC_EXTENSION, true)(target, key, descriptor);
  };
}

export interface PublicOptions {
  /**
   * Do not even look at an Authorization header (health probes: they must answer the
   * same with or without one, and cost no crypto on an unthrottled route).
   */
  readonly ignoreToken?: boolean;
}

export const Access = {
  /**
   * Anyone may call this route. A token that is sent is still verified (a bad one is a
   * 401, never a silent downgrade) unless the identity provider is unavailable, but it
   * is not resolved: the handler sees an anonymous actor.
   */
  public(reason: string, options: PublicOptions = {}): MethodDecorator {
    if (!reason.trim()) throw new TypeError('@Access.public needs a reason');
    return declare({ kind: 'public', reason, ignoreToken: options.ignoreToken ?? false });
  },
  user(): MethodDecorator {
    return declare({ kind: 'user' });
  },
  admin(): MethodDecorator {
    return declare({ kind: 'admin' });
  },
  identity(): MethodDecorator {
    return declare({ kind: 'identity' });
  },
};

/** The policy a handler declared, if any. */
export function accessPolicyOf(handler: object): AccessPolicy | undefined {
  return Reflect.getMetadata(ACCESS_POLICY, handler) as AccessPolicy | undefined;
}
