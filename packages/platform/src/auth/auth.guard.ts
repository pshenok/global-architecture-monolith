import { adminRoleRequired, DependencyUnavailableError, PermissionDeniedError } from '@gam/kernel';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AccessRoutes } from './access-routes.ts';
import { AccessTokenVerifier, bearerToken, tokenMissing } from './access-token-verifier.ts';
import { enterActor, identityActorOf, userActorOf } from './actor-context.ts';
import { acceptedEmail } from './email-claims.ts';
import { IdentityResolver } from './identity-resolver.ts';

export const userNotRegistered = () =>
  new PermissionDeniedError(
    'USER_NOT_REGISTERED',
    'this login has no user yet: register with POST /v1/users',
  );

/**
 * Authenticates every HTTP request (ADR-0004) by the policy its route recorded at boot
 * (AccessRoutes): public routes take anyone, identity routes a verified login, user and
 * admin routes the platform user the IdentityResolver finds for the login, looked up on
 * every request. On success the request context holds the actor that controllers pass to
 * use cases (`currentUser()`, `currentIdentity()`).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly routes: AccessRoutes,
    private readonly verifier: AccessTokenVerifier,
    private readonly resolver: IdentityResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Fail closed: the app serves HTTP only, any other transport is not authenticated.
    if (context.getType() !== 'http') return false;
    const policy = this.routes.policyOf(context.getClass(), context.getHandler());
    if (policy === 'unknown') {
      // A server bug (500), never something a client can fix by signing in.
      throw new Error(
        `${context.getClass().name}.${context.getHandler().name} was not a route when the app started`,
      );
    }
    if (policy.kind === 'public' && policy.ignoreToken) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = bearerToken(request.headers.authorization);

    if (policy.kind === 'public') {
      // A token that is sent must be valid; it is not used for anything else, so an
      // identity-provider outage does not take public routes down with it.
      if (token) {
        await this.verifier.verify(token).catch((error: unknown) => {
          if (!(error instanceof DependencyUnavailableError)) throw error;
        });
      }
      return true;
    }
    if (!token) throw tokenMissing();
    const verified = await this.verifier.verify(token);

    if (policy.kind === 'identity') {
      const email = await acceptedEmail(verified);
      enterActor(identityActorOf(verified.issuer.issuer, verified.subject, email));
      return true;
    }
    const user = await this.resolver.resolve(
      identityActorOf(verified.issuer.issuer, verified.subject, null),
    );
    if (!user) throw userNotRegistered();
    if (policy.kind === 'admin' && !user.roles.includes('admin')) throw adminRoleRequired();
    enterActor(userActorOf(user.userId, user.roles));
    return true;
  }
}
