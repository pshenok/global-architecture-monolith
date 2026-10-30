/**
 * Self-test of tools/check-access.ts, which reads this file as if it were production code
 * in the houses module: every line marked `refused` must be refused, and no other line.
 * Each probe is a way to make a verified actor without the platform kit that a review
 * found. Nothing imports or runs this file.
 */

import type * as kernel from '@gam/kernel';
import { type Actor, isAdmin, type ServiceActor, type UserActor } from '@gam/kernel';
import { userActor } from '@gam/kernel/testing'; // refused
import { Access, currentUser, type EventPayload, OnEvent } from '@gam/platform';
import { USER_DELETED } from '@gam/users';
import { Body, Controller, Inject, Injectable, Post } from '@nestjs/common';

type Verified = UserActor;
interface Job {
  readonly requestedBy: UserActor;
}
const raw: unknown = JSON.parse('{"kind":"user","userId":"victim","roles":["admin"]}');

// Assertions, through any spelling of the type.
export const viaNamespace = raw as kernel.UserActor; // refused
export const viaAlias = raw as Verified; // refused
export const viaExtract = raw as Extract<Actor, { kind: 'user' }>; // refused
export const viaNever = raw as never; // refused
export const viaField = (raw as Job).requestedBy; // refused
export const viaArray = raw as readonly UserActor[]; // refused
export const viaRecord = raw as Readonly<Record<string, UserActor>>; // refused
export const viaPromise = raw as Promise<UserActor>; // refused
export const viaFunction = raw as () => UserActor; // refused
export const viaMapped = raw as Readonly<{ actor: UserActor }>; // refused
export const viaNeverField = (raw as { actor: never }).actor; // refused

// Generic casts and the calls that use them.
export function cast<T>(value: unknown): T {
  return value as T; // refused
}
export function castNonNull<T>(value: unknown): NonNullable<T> {
  return value as NonNullable<T>; // refused
}
export function castThroughAlias<T>(value: unknown): T {
  type Same = T;
  return value as Same; // refused
}
export const castActor: UserActor = cast(raw); // refused

// Type predicates that claim more than they check.
export function isUser(value: unknown): value is Verified {
  // refused
  return value !== null;
}
export function isAnything<T>(value: unknown): value is T {
  // refused
  return value !== null;
}
export function isLoose<T>(value: T | object): value is T {
  // refused
  return value !== null;
}

// Copies of a real actor.
export const promoted: UserActor = { ...currentUser(), roles: ['admin'] }; // refused
export const cloned = structuredClone(currentUser()); // refused
export const merged = Object.assign({}, currentUser(), { userId: 'victim' }); // refused
const context: { actor?: UserActor } = {};
export const filled = Object.assign(context, { actor: { kind: 'user', userId: 'v' } }).actor; // refused

// Fields, parameters and declarations that claim an actor nobody produced.
export class Dto<T> {
  readonly value!: T; // refused
  constructor(source: object) {
    Object.assign(this, { value: source });
  }
}
export const fromDto = new Dto<UserActor>({}).value; // refused
export class Session {
  actor!: UserActor; // refused
}
@Injectable()
export class Holder {
  constructor(@Inject('ACTOR') readonly actor: UserActor) {} // refused
}
@Controller('probe')
export class ProbeController {
  @Post()
  @Access.admin()
  revoke(@Body() actor: UserActor) {
    // refused
    return isAdmin(actor);
  }
}
@Injectable()
export class ProbeConsumer {
  @OnEvent(USER_DELETED)
  async handle(
    _event: EventPayload<typeof USER_DELETED>,
    actor?: ServiceActor, // refused
  ): Promise<void> {
    await Promise.resolve(actor?.name);
  }
}
export const fromCallback = JSON.parse('[]').map((actor: Verified) => actor.userId); // refused
export function* stream(): Generator<UserActor> {
  yield JSON.parse('{}'); // refused
}
export function overload(value: unknown): UserActor; // refused
export function overload(value: unknown) {
  return value;
}
declare const ambient: UserActor; // refused
export const fromAmbient = ambient;
declare global {
  // refused
  interface JSON {
    parse(text: string, kind: 'actor'): UserActor;
  }
}

// Keys, generic classes, suppressions, test helpers and hand-made metadata.
declare const brand: Exclude<keyof UserActor, 'kind' | 'userId' | 'roles'>;
export const keyed: UserActor = { [brand]: true, kind: 'user', userId: 'v', roles: [] }; // refused
export class Box<T> {
  constructor(private readonly content: unknown) {}
  current?: T;
  as(): T {
    return this.content as T; // refused
  }
  self() {
    return this.content as typeof this.current; // refused
  }
}
export const fromBox = new Box<UserActor>(raw).as(); // refused
// @ts-expect-error -- an unchecked literal typed as an actor // refused
export const ignored: UserActor = raw;
// oxlint-disable-next-line typescript/no-unsafe-assignment // refused
export const lintless = raw;
export const fake = userActor('victim', ['admin']); // refused

// Fine: the ways production code really gets and uses an actor.
export const signedIn = currentUser();
export const roles = signedIn.roles;
export const owner: { readonly actor: UserActor } = { actor: signedIn };
export const fromOwner = owner.actor;
export const later = Promise.resolve(currentUser());
export const cache = new Map<string, UserActor>();
export const isDefined = <T>(value: T | undefined): value is T => value !== undefined;
export const isPresent = <T>(value: T): value is NonNullable<T> => value !== null;
export function mayChange<A extends Actor>(actor: A, ownerId: string): boolean {
  return actor.kind === 'user' && actor.userId === ownerId;
}
export const parsed = JSON.parse('{"name":"x"}') as { name: string };
export const label = 'x' as string;
export const Visibility = { Public: 'public', Unlisted: 'unlisted' } as const;
export const PAGE_LIMIT = 50; // Access to more pages needs a token
