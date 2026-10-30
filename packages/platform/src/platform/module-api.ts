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

/**
 * Marks the class other modules call: a module's public API (`src/transport/api`),
 * exported from its package and its Nest module, the in-process counterpart of a
 * service's RPC interface. Every method is async and refuses to run inside the caller's
 * transaction (CrossModuleCallInTransactionError), the boundary rule a network call
 * would enforce by itself.
 *
 *   @ModuleApi()
 *   @Injectable()
 *   export class HousesApi { async findHouse(id: string): Promise<HouseSummary | null> { ... } }
 */
export function ModuleApi(): ClassDecorator {
  return (target) => {
    moduleApis.add(target);
    const prototype = target.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      const original = descriptor?.value as ((...args: unknown[]) => unknown) | undefined;
      if (!descriptor || typeof original !== 'function') continue;
      const member = `${target.name}.${name}`;
      const guarded = function (this: unknown, ...args: unknown[]): unknown {
        if (inTransaction()) return Promise.reject(new CrossModuleCallInTransactionError(member));
        return original.apply(this, args);
      };
      Object.defineProperty(guarded, 'name', { value: name });
      Object.defineProperty(prototype, name, { ...descriptor, value: guarded });
    }
  };
}
