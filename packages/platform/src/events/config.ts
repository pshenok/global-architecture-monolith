import { z } from 'zod';

/**
 * Event variables (ADR-0005), part of platformConfigSchema.
 *
 * Shutdown budget: EVENTS_DRAIN_MS must stay below the time the process manager waits
 * before it kills the process (PM2 kill_timeout, Kubernetes
 * terminationGracePeriodSeconds), so an in-flight delivery can finish.
 */
export const eventsConfigSchema = z.object({
  /** Run the delivery loop. Tests turn it off and drive deliveries by hand. */
  EVENTS_AUTOSTART: z.stringbool().default(true),
  /** Idle wait between rounds that found nothing due. */
  EVENTS_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(500),
  /** Deliveries one round processes, one transaction each, before it looks again. */
  EVENTS_BATCH: z.coerce.number().int().min(1).max(500).default(50),
  /** How long shutdown waits for an in-flight delivery. */
  EVENTS_DRAIN_MS: z.coerce.number().int().min(0).max(14_000).default(5_000),
});

export type EventsConfig = z.output<typeof eventsConfigSchema>;
