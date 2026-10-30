import { Injectable, type Type } from '@nestjs/common';
import { MetadataScanner, type ModuleRef } from '@nestjs/core';
import type { EventType } from './event-type.ts';
import { handledEventOf } from './on-event.ts';

/** What one module declares in `EventsModule.forFeature`. */
export interface EventFeatureOptions {
  /** The module's name (kebab-case): the producer prefix of its event types, the subscriber of its handlers. */
  readonly module: string;
  /** Records events with Outbox (injectable in the module). */
  readonly publish?: boolean;
  /** Providers of the module with @OnEvent handlers. */
  readonly consumers?: readonly Type[];
}

/** One module's handler of one event type. */
export interface Subscription {
  readonly module: string;
  readonly event: EventType;
  readonly consumer: Type;
  /** `Class.method`. */
  readonly member: string;
  readonly method: string;
}

export interface EventFeature {
  readonly module: string;
  readonly publish: boolean;
  readonly subscriptions: readonly Subscription[];
}

const MODULE_NAME = /^[a-z][a-z0-9-]*[a-z0-9]$/;

/**
 * Reads a feature's handlers from its consumer classes (no instances needed). Throws on a
 * bad module name, a consumer without handlers, or two handlers of one type.
 */
export function eventFeatureOf(options: EventFeatureOptions): EventFeature {
  if (!MODULE_NAME.test(options.module)) {
    throw new TypeError(
      `EventsModule.forFeature: module must be kebab-case, got "${options.module}"`,
    );
  }
  const consumers = options.consumers ?? [];
  if (!options.publish && consumers.length === 0) {
    throw new TypeError(
      `EventsModule.forFeature(${options.module}) needs publish, consumers or both`,
    );
  }
  const scanner = new MetadataScanner();
  const byType = new Map<string, Subscription>();
  for (const consumer of consumers) {
    const prototype = consumer.prototype as Record<string, unknown>;
    let found = 0;
    for (const method of scanner.getAllMethodNames(prototype)) {
      const event = handledEventOf(prototype[method]);
      if (!event) continue;
      found += 1;
      const member = `${consumer.name}.${method}`;
      const existing = byType.get(event.type);
      if (existing) {
        throw new Error(
          `${options.module} has two handlers of ${event.type}: ${existing.member} and ${member}`,
        );
      }
      byType.set(event.type, { module: options.module, event, consumer, member, method });
    }
    if (found === 0) {
      throw new Error(
        `${consumer.name} is a consumer of ${options.module} but has no @OnEvent handler`,
      );
    }
  }
  return Object.freeze({
    module: options.module,
    publish: options.publish === true,
    subscriptions: Object.freeze([...byType.values()]),
  });
}

/** Every feature declared in this process so far, by module: what the operator CLI checks. */
const catalog = new Map<string, EventFeature>();

/** Records a feature in the process-wide catalog; the same module twice must declare the same. */
export function addToCatalog(feature: EventFeature): void {
  const existing = catalog.get(feature.module);
  if (existing && !sameFeature(existing, feature)) {
    throw new Error(`EventsModule.forFeature(${feature.module}) is declared twice, differently`);
  }
  catalog.set(feature.module, feature);
}

function sameFeature(a: EventFeature, b: EventFeature): boolean {
  const key = (feature: EventFeature) =>
    JSON.stringify([
      feature.publish,
      feature.subscriptions.map((s) => [s.event.type, s.member]).sort(),
    ]);
  return key(a) === key(b);
}

/**
 * The (subscriber, event type) pairs of every feature module imported so far. The
 * operator CLI imports the app module, then asks this, without starting the app.
 */
export function eventCatalog(): readonly { readonly subscriber: string; readonly type: string }[] {
  return [...catalog.values()].flatMap((feature) =>
    feature.subscriptions.map((s) => ({ subscriber: s.module, type: s.event.type })),
  );
}

type Invoke = (payload: unknown) => Promise<void>;

/**
 * The features of the running app, registered by each `EventsModule.forFeature` it
 * mounts. Outbox asks it who subscribes to a type (one delivery per subscriber); the
 * EventDispatcher asks it for the handler of a delivery, once it is sealed at bootstrap.
 */
@Injectable()
export class EventRegistry {
  private readonly features = new Map<string, EventFeature>();
  private readonly subscribers = new Map<string, Map<string, Subscription>>();
  private readonly handlers = new Map<Subscription, Invoke>();
  private sealed = false;

  register(feature: EventFeature): void {
    if (this.sealed) throw new Error(`EventsModule: ${feature.module} registered after bootstrap`);
    if (this.features.has(feature.module)) {
      throw new Error(`EventsModule.forFeature(${feature.module}) is mounted twice`);
    }
    this.features.set(feature.module, feature);
    for (const subscription of feature.subscriptions) {
      const byModule =
        this.subscribers.get(subscription.event.type) ?? new Map<string, Subscription>();
      byModule.set(subscription.module, subscription);
      this.subscribers.set(subscription.event.type, byModule);
    }
  }

  /** Whether `module` may publish (declared `publish: true`). */
  publishes(module: string): boolean {
    return this.features.get(module)?.publish === true;
  }

  /** Modules that handle `type`, in a stable order. */
  subscribersOf(type: string): readonly string[] {
    return [...(this.subscribers.get(type)?.keys() ?? [])].sort();
  }

  /** Every subscription of the app. */
  subscriptions(): readonly Subscription[] {
    return [...this.features.values()].flatMap((feature) => feature.subscriptions);
  }

  /** Resolves each consumer's instance; fails boot when a consumer is not a provider. */
  seal(moduleRef: ModuleRef): void {
    if (this.sealed) return;
    for (const subscription of this.subscriptions()) {
      let instance: Record<string, unknown>;
      try {
        instance = moduleRef.get(subscription.consumer, { strict: false });
      } catch (error) {
        throw new Error(
          `${subscription.consumer.name} (a consumer of ${subscription.module}) is not a provider: add it to the module's providers`,
          { cause: error },
        );
      }
      const method = instance[subscription.method] as (payload: unknown) => Promise<void>;
      this.handlers.set(subscription, (payload) => method.call(instance, payload));
    }
    this.sealed = true;
  }

  /** The handler of `module` for `type`, once sealed; undefined when the module has none. */
  handlerOf(
    module: string,
    type: string,
  ): { readonly subscription: Subscription; readonly invoke: Invoke } | undefined {
    const subscription = this.subscribers.get(type)?.get(module);
    const invoke = subscription && this.handlers.get(subscription);
    return subscription && invoke ? { subscription, invoke } : undefined;
  }
}
