/**
 * Cross-cutting ports. Abstract classes (not interfaces) so they double as Nest DI
 * tokens: `constructor(private readonly ids: IdGenerator)` needs no @Inject().
 */

/** Generates entity ids. Production uses UUIDv7 (time-ordered, sortable). */
export abstract class IdGenerator {
  abstract newId(): string;
}

/** Current time. Inject it instead of calling `new Date()` so tests control time. */
export abstract class Clock {
  abstract now(): Date;
}

/**
 * Runs `work` in one database transaction. Repositories used inside `work`
 * automatically join the transaction; an exception rolls everything back.
 */
export abstract class UnitOfWork {
  abstract run<T>(work: () => Promise<T>): Promise<T>;
}
