import {
  type Actor,
  ANONYMOUS,
  type IdentityActor,
  type Role,
  type ServiceActor,
  UnauthenticatedError,
  type UserActor,
} from '@gam/kernel';
import { type ClsService, ClsServiceManager } from 'nestjs-cls';

const CLS_ACTOR = 'gam.auth.actor';
const CLS_EVENT = 'gam.events.event';

/** The event a handler is processing (ADR-0005); only the kit's EventDispatcher sets it. */
export interface EventInfo {
  readonly id: string;
  /** Event type, e.g. `houses.v1.HouseDeletedEvent`. */
  readonly type: string;
  /** Module that published it. */
  readonly producer: string;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  /** 1 on the first delivery, then one more per retry. */
  readonly attempt: number;
}

function activeCls(): ClsService | undefined {
  try {
    const cls = ClsServiceManager.getClsService();
    return cls.isActive() ? cls : undefined;
  } catch {
    return undefined;
  }
}

/*
 * The only places verified actors are minted: the AuthGuard (from a token it verified and
 * the user the users module resolved) and the EventDispatcher (a module handling an
 * event). Not exported from the package.
 */

export function userActorOf(userId: string, roles: readonly Role[]): UserActor {
  return Object.freeze({ kind: 'user', userId, roles: Object.freeze([...roles]) }) as UserActor;
}

export function identityActorOf(
  issuer: string,
  subject: string,
  email: string | null,
): IdentityActor {
  return Object.freeze({ kind: 'identity', issuer, subject, email }) as IdentityActor;
}

export function serviceActorOf(name: string): ServiceActor {
  return Object.freeze({ kind: 'service', name }) as ServiceActor;
}

/** For the AuthGuard only: makes `actor` the actor of the current request. */
export function enterActor(actor: UserActor | IdentityActor): void {
  const cls = activeCls();
  if (!cls) throw new Error('enterActor needs an active request context (CLS)');
  cls.set(CLS_ACTOR, actor);
}

/** For the EventDispatcher only: a delivery runs as the subscribing module itself. */
export function enterEventDelivery(cls: ClsService, module: string, event: EventInfo): void {
  cls.set(CLS_ACTOR, serviceActorOf(module));
  cls.set(CLS_EVENT, Object.freeze({ ...event }));
}

/** A value of the current request context; undefined outside a request. */
function fromCls(key: string): unknown {
  return activeCls()?.get(key);
}

/** The actor of the current request; anonymous outside a request or on public routes. */
export function currentActor(): Actor {
  return (fromCls(CLS_ACTOR) as Actor | undefined) ?? ANONYMOUS;
}

/** The registered user of the current request. Throws UNAUTHENTICATED when there is none. */
export function currentUser(): UserActor {
  const actor = currentActor();
  if (actor.kind !== 'user') {
    throw new UnauthenticatedError('AUTHENTICATION_REQUIRED', 'this operation requires a user');
  }
  return actor;
}

/** The IdP identity of the current request (registration). Throws UNAUTHENTICATED otherwise. */
export function currentIdentity(): IdentityActor {
  const actor = currentActor();
  if (actor.kind !== 'identity') {
    throw new UnauthenticatedError('IDENTITY_REQUIRED', 'this operation requires an identity');
  }
  return actor;
}

/**
 * The module acting as itself: inside an `@OnEvent` handler, the module that subscribed.
 * Throws UNAUTHENTICATED everywhere else. Use cases that only a module itself may run
 * (cleanups after another module's event) take it as their first argument.
 */
export function currentService(): ServiceActor {
  const actor = currentActor();
  if (actor.kind !== 'service') {
    throw new UnauthenticatedError('SERVICE_REQUIRED', 'this operation requires a module');
  }
  return actor;
}

/** The event being handled, inside an `@OnEvent` handler; undefined everywhere else. */
export function currentEvent(): EventInfo | undefined {
  return fromCls(CLS_EVENT) as EventInfo | undefined;
}
