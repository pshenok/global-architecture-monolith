import type { EventPayload, EventType } from './event-type.ts';

/** Handler method -> the event type it handles. Only @OnEvent writes it. */
const handlers = new WeakMap<object, EventType>();

/**
 * Marks a provider method as its module's handler of one event type (ADR-0005). List the
 * provider in the module's `EventsModule.forFeature({ consumers })`. The kit's
 * EventDispatcher calls the method with the validated payload, inside one transaction
 * that also marks the delivery done: the handler's writes and the acknowledgement commit
 * together, so an event takes effect once per subscribing module. Put handlers in
 * `src/transport/events/`, call one use case with `currentService()`, and call no other
 * module (that is refused inside the transaction). A module has at most one handler per
 * type.
 *
 *   @OnEvent(HOUSE_DELETED)
 *   async houseDeleted(event: EventPayload<typeof HOUSE_DELETED>): Promise<void> {
 *     await this.bookings.cancelOpenStaysOfHouse(currentService(), event.houseId);
 *   }
 *
 * Handlers must not depend on order (events of one aggregate can arrive in any order),
 * and should be idempotent in effect: an operator replay delivers an event again.
 */
export function OnEvent<E extends EventType>(event: E) {
  return (
    _target: object,
    _key: string | symbol,
    descriptor: TypedPropertyDescriptor<(payload: EventPayload<E>) => Promise<void>>,
  ): void => {
    if (descriptor.value) handlers.set(descriptor.value, event);
  };
}

/** The event type a method handles, if it is an @OnEvent handler. */
export function handledEventOf(method: unknown): EventType | undefined {
  return typeof method === 'function' ? handlers.get(method) : undefined;
}
