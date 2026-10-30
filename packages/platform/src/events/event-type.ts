import type { z } from 'zod';

/** `<module>.v<N>.<Aggregate><PastFact>Event`, e.g. `houses.v1.HouseDeletedEvent`. */
const EVENT_TYPE = /^([a-z][a-z0-9-]*[a-z0-9])\.v\d+\.[A-Z][A-Za-z0-9]*Event$/;

/** A JSON-safe payload schema: an object of strings, numbers, booleans, nulls, arrays, objects. */
export type PayloadSchema = z.ZodObject;

/**
 * An event type: its name (also the topic), the only module that may publish it (the
 * first segment of the name) and the Zod schema of its JSON payload.
 */
export interface EventType<S extends PayloadSchema = PayloadSchema> {
  readonly type: string;
  readonly producer: string;
  readonly schema: S;
}

/** The payload of an event type, as handlers receive it. */
export type EventPayload<E extends EventType> = z.output<E['schema']>;

/**
 * Declares an event type, once, in the producing module, which exports it from its public
 * API (src/index.ts). Subscribers import it from there:
 *
 *   export const HOUSE_DELETED = defineEvent(
 *     'houses.v1.HouseDeletedEvent',
 *     z.object({ houseId: z.uuid(), ownerId: z.uuid() }),
 *   );
 *
 * The payload is stored as JSON, so its fields are JSON values: ids and timestamps travel
 * as strings. Evolve it like a public API: add optional fields, never change or remove
 * one; a breaking change is a new type (`.v2.`). Throws when the name breaks the convention.
 */
export function defineEvent<S extends PayloadSchema>(type: string, schema: S): EventType<S> {
  const match = EVENT_TYPE.exec(type);
  if (!match) {
    throw new TypeError(`event type "${type}" is not <module>.v<N>.<Aggregate><PastFact>Event`);
  }
  return Object.freeze({ type, producer: match[1] as string, schema });
}
