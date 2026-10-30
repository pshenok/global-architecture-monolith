import { TransactionHost } from '@nestjs-cls/transactional';

/**
 * A module's public API was called inside another transaction: a cross-module call in a
 * UnitOfWork (or an event handler). Modules never share a transaction (ADR-0002), so
 * either can later move to its own database: read what you need before the transaction,
 * or react to an event instead.
 */
export class CrossModuleCallInTransactionError extends Error {
  constructor(member: string) {
    super(
      `${member} was called inside a transaction: modules never share one (ADR-0002); call it before UnitOfWork.run, or react to an event`,
    );
    this.name = 'CrossModuleCallInTransactionError';
  }
}

const moduleApis = new WeakSet<object>();

/** Whether a class is a module's public API (decorated with @ModuleApi). */
export function isModuleApi(type: unknown): boolean {
  return typeof type === 'function' && moduleApis.has(type);
}

function inTransaction(): boolean {
  try {
    return TransactionHost.getInstance().isTransactionActive();
  } catch {
    // No transaction host (no database, or outside any request context).
    return false;
  }
}

/** A method or accessor of `prototype`, wrapped so it refuses to run inside a transaction. */
function guard(prototype: object, key: string | symbol, member: string): PropertyDescriptor {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key) as PropertyDescriptor;
  const refuse = () => new CrossModuleCallInTransactionError(member);
  const wrap = (original: (...args: unknown[]) => unknown, name: string, async: boolean) => {
    const guarded = function (this: unknown, ...args: unknown[]): unknown {
      if (inTransaction()) {
        // A method answers with a rejected promise (it is async); an accessor throws.
        if (async) return Promise.reject(refuse());
        throw refuse();
      }
      return original.apply(this, args);
    };
    Object.defineProperty(guarded, 'name', { value: name });
    return guarded;
  };
  if (typeof descriptor.value === 'function') {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    return { ...descriptor, value: wrap(original, original.name, true) };
  }
  return {
    ...descriptor,
    ...(descriptor.get ? { get: wrap(descriptor.get, `get ${String(key)}`, false) } : {}),
    ...(descriptor.set ? { set: wrap(descriptor.set, `set ${String(key)}`, false) } : {}),
  };
}

/**
 * Marks the class other modules call: a module's public API (`src/transport/api`),
 * exported from its package and its Nest module, the in-process counterpart of a
 * service's RPC interface. Every method (inherited and symbol-keyed ones included) is
 * async and refuses to run inside the caller's transaction
 * (CrossModuleCallInTransactionError), the boundary rule a network call would enforce by
 * itself; so do accessors, by throwing. Methods written as class fields (`find = async () =>`)
 * cannot be wrapped: the app refuses to start with one (ModuleApiCheck).
 *
 *   @ModuleApi()
 *   @Injectable()
 *   export class HousesApi { async findHouse(id: string): Promise<HouseSummary | null> { ... } }
 */
export function ModuleApi(): ClassDecorator {
  return (target) => {
    moduleApis.add(target);
    const prototype = target.prototype as object;
    const seen = new Set<string | symbol>(['constructor']);
    // The class's own members, then what it inherits (the nearest definition wins).
    for (
      let source: object | null = prototype;
      source && source !== Object.prototype;
      source = Object.getPrototypeOf(source) as object | null
    ) {
      for (const key of Reflect.ownKeys(source)) {
        if (seen.has(key)) continue;
        seen.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(source, key) as PropertyDescriptor;
        const callable = typeof descriptor.value === 'function' || descriptor.get || descriptor.set;
        if (!callable) continue;
        Object.defineProperty(prototype, key, guard(source, key, `${target.name}.${String(key)}`));
      }
    }
  };
}

/** The functions a ModuleApi instance holds as its own fields: they skip the guard. */
export function unguardedMembers(instance: object): string[] {
  return Reflect.ownKeys(instance)
    .filter((key) => typeof (instance as Record<string | symbol, unknown>)[key] === 'function')
    .map(String);
}
