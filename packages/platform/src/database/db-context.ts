import { UnitOfWork } from '@gam/kernel';
import { Injectable } from '@nestjs/common';
import { TransactionHost } from '@nestjs-cls/transactional';
import type { TransactionalAdapterDrizzleOrm } from '@nestjs-cls/transactional-adapter-drizzle-orm';
import type { Database } from './tokens.ts';

/**
 * What repositories inject. `tx` is the current transaction when called inside
 * `UnitOfWork.run()`, otherwise the root database, so repositories never care
 * whether they run in a transaction.
 */
@Injectable()
export class DbContext {
  constructor(private readonly host: TransactionHost<TransactionalAdapterDrizzleOrm<Database>>) {}

  get tx(): Database {
    return this.host.tx;
  }

  /** True inside `UnitOfWork.run()`: what the outbox and the cross-module call guard check. */
  inTransaction(): boolean {
    return this.host.isTransactionActive();
  }
}

/**
 * UnitOfWork port backed by nestjs-cls transactions. Nested run() calls join the outer
 * transaction (Propagation.Required); there is no savepoint.
 */
@Injectable()
export class DrizzleUnitOfWork extends UnitOfWork {
  constructor(private readonly host: TransactionHost<TransactionalAdapterDrizzleOrm<Database>>) {
    super();
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return this.host.withTransaction(work);
  }
}
