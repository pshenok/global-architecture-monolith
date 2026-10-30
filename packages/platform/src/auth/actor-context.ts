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

/*
 * Private keys and a record of what the kit minted: a value another module puts into the
 * request context by hand is never taken for an actor or an event (the kit's own values
 * are the only ones in `minted`).
 */
const CLS_ACTOR = Symbol('gam.auth.actor');
const CLS_EVENT = Symbol('gam.events.event');
const minted = new WeakSet<object>();

function mint<T extends object>(value: T): T {
  minted.add(value);
  return value;
}

/** The request context's store, keyed by the symbols above. */
function storeOf(cls: ClsService): Record<symbol, unknown> | undefined {
  return cls.get();
}

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
  return mint(
    Object.freeze({ kind: 'user', userId, roles: Object.freeze([...roles]) }) as UserActor,
  );
}

export function identityActorOf(
  issuer: string,
  subject: string,
  email: string | null,
): IdentityActor {
  return mint(Object.freeze({ kind: 'identity', issuer, subject, email }) as IdentityActor);
}

export function serviceActorOf(name: string): ServiceActor {
  return mint(Object.freeze({ kind: 'service', name }) as ServiceActor);
}

/** For the AuthGuard only: makes `actor` the actor of the current request. */
export function enterActor(actor: UserActor | IdentityActor): void {
  const store = (() => {
    const cls = activeCls();
    return cls && storeOf(cls);
  })();
  if (!store) throw new Error('enterActor needs an active request context (CLS)');
  store[CLS_ACTOR] = actor;
}

/** For the EventDispatcher only: a delivery runs as the subscribing module itself. */
export function enterEventDelivery(cls: ClsService, module: string, event: EventInfo): void {
  const store = storeOf(cls);
  if (!store) throw new Error('enterEventDelivery needs an active request context (CLS)');
  store[CLS_ACTOR] = serviceActorOf(module);
  store[CLS_EVENT] = mint(Object.freeze({ ...event }));
}

/** A value the kit put into the current request context; undefined for anything else. */
function fromCls(key: symbol): object | undefined {
  const cls = activeCls();
  const value = cls && storeOf(cls)?.[key];
  return typeof value === 'object' && value !== null && minted.has(value) ? value : undefined;
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
