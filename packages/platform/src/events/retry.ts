import { type DomainErrorKind, isDomainError } from '@gam/kernel';
import { translateDbError } from '../database/pg-errors.ts';
import { CrossModuleCallInTransactionError } from '../platform/module-api.ts';

/** Attempts a delivery gets before it becomes a dead letter. */
export const MAX_ATTEMPTS = 10;

/**
 * Wait before a failed delivery is tried again: 1 s, 2 s, 4 s ... capped at 5 min. With
 * 10 attempts, a delivery that fails every time waits about 8.5 minutes in all
 * (1 + 2 + ... + 256 s) before it is dead.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 300_000);
}

/** What to do with a delivery whose handler failed. */
export interface FailureAction {
  /** retry: after the backoff; dead: stop, keep it as a dead letter. */
  readonly action: 'retry' | 'dead';
  readonly reason: string;
  readonly message: string;
}

/** Failures that can go away by themselves; every other domain error is deterministic. */
const TRANSIENT = new Set<DomainErrorKind>(['ABORTED', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED']);

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current !== undefined && chain.length < 5; ) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

/**
 * Classifies a handler failure. Transient domain errors (and database serialization
 * failures, deadlocks and timeouts) retry; other domain errors dead-letter, since the
 * same input fails the same way; a call to another module inside the transaction is a
 * bug and dead-letters; anything else (a bug or an outage we cannot tell apart) retries.
 */
export function classifyFailure(error: unknown): FailureAction {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  if (causes(error).some((e) => e instanceof CrossModuleCallInTransactionError)) {
    return { action: 'dead', reason: 'CROSS_MODULE_CALL_IN_TRANSACTION', message };
  }
  const translated = isDomainError(error) ? error : translateDbError(error);
  if (isDomainError(translated)) {
    return {
      action: TRANSIENT.has(translated.kind) ? 'retry' : 'dead',
      reason: translated.reason,
      message: translated.message.slice(0, 1000),
    };
  }
  return { action: 'retry', reason: 'HANDLER_FAILED', message };
}
