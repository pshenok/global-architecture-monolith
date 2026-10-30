import { Injectable, Logger, type OnModuleInit, type Type } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import { ACCESS_POLICY, type AccessPolicy, accessPolicyOf } from './access.ts';

/** A route callable without a registered user, as security/public-endpoints.json lists it. */
export interface OpenRoute {
  /** `Class.method`. */
  readonly member: string;
  readonly access: 'public' | 'identity';
  readonly reason: string;
}

/** Policies by controller, then by handler (the prototype method and any bound copy). */
type PolicyTable = Map<Type, Map<object, AccessPolicy>>;

/** How security/public-endpoints.json (and tools/check-access.ts) describe an open policy. */
function opening(policy: AccessPolicy): Omit<OpenRoute, 'member'> | undefined {
  switch (policy.kind) {
    case 'public':
      return { access: 'public', reason: policy.reason };
    case 'identity':
      return { access: 'identity', reason: 'login without a user' };
    case 'user':
    case 'admin':
      return undefined;
  }
}

/**
 * The access policy of every route of these controllers, and the routes open without a
 * registered user. Policies are kept per controller: two controllers that inherit one
 * handler from a base class keep their own records. Throws when a route declares no
 * policy or a controller carries one on the class.
 */
export function accessRoutesOf(
  controllers: readonly { readonly type: Type; readonly instance?: unknown }[],
): { policies: PolicyTable; open: OpenRoute[] } {
  const scanner = new MetadataScanner();
  const policies: PolicyTable = new Map();
  const open: OpenRoute[] = [];
  const undeclared: string[] = [];
  for (const { type, instance } of controllers) {
    if (Reflect.hasMetadata(ACCESS_POLICY, type)) {
      throw new Error(`@Access must be on route methods, not on ${type.name}`);
    }
    const handlers = new Map<object, AccessPolicy>();
    policies.set(type, handlers);
    const prototype = type.prototype as Record<string, unknown>;
    const names = scanner.getAllMethodNames(prototype);
    const methods = new Set(names.map((name) => prototype[name]));
    const bound = new Map<object, AccessPolicy>();
    const shared = new Set<object>();
    for (const name of names) {
      const handler = prototype[name];
      if (
        typeof handler !== 'function' ||
        Reflect.getMetadata(METHOD_METADATA, handler) === undefined
      ) {
        continue;
      }
      const member = `${type.name}.${name}`;
      const policy = accessPolicyOf(handler);
      if (!policy) {
        undeclared.push(member);
        continue;
      }
      handlers.set(handler, policy);
      // Nest calls instance[name]: a method bound in the constructor is a new function.
      // Another method put there (an alias) keeps its own policy, never this route's.
      const copy = (instance as Record<string, unknown> | undefined)?.[name];
      if (typeof copy === 'function' && !methods.has(copy)) {
        if (bound.has(copy)) shared.add(copy);
        bound.set(copy, policy);
      }
      const opened = opening(policy);
      if (opened) open.push({ member, ...opened });
    }
    // A copy that two routes share stays unknown: the guard refuses it (fail closed).
    for (const [copy, policy] of bound) {
      if (!handlers.has(copy) && !shared.has(copy)) handlers.set(copy, policy);
    }
  }
  if (undeclared.length > 0) {
    throw new Error(
      `routes without an @Access policy: ${undeclared.join(', ')}. Declare one on each route method (ADR-0004).`,
    );
  }
  return { policies, open };
}

/**
 * The access policy of every route, recorded once at boot (ADR-0004). The AuthGuard
 * enforces this record, and createTestApp compares `open` with
 * security/public-endpoints.json, so what the tests check is what runs: metadata changed
 * after boot changes nothing, and a handler that was not a route at boot is refused.
 */
@Injectable()
export class AccessRoutes implements OnModuleInit {
  private readonly logger = new Logger('AccessPolicy');
  private policies: PolicyTable = new Map();
  private recorded: readonly OpenRoute[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const controllers = this.discovery
      .getControllers()
      .flatMap(({ metatype, instance }) =>
        typeof metatype === 'function'
          ? [{ type: metatype as Type, instance: instance as unknown }]
          : [],
      );
    const { policies, open } = accessRoutesOf(controllers);
    this.policies = policies;
    this.recorded = Object.freeze(open);
    if (open.length > 0) {
      this.logger.log(
        `open without a user: ${open.map((o) => `${o.member} [${o.access}] ${o.reason}`).join(', ')}`,
      );
    }
  }

  /** Routes open without a registered user. */
  get open(): readonly OpenRoute[] {
    return this.recorded;
  }

  /** The recorded policy of a controller's handler; `unknown` if it was not a route at boot. */
  policyOf(controller: Type, handler: object): AccessPolicy | 'unknown' {
    return this.policies.get(controller)?.get(handler) ?? 'unknown';
  }
}
