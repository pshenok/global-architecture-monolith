CREATE SCHEMA "events";
--> statement-breakpoint
CREATE TABLE "events"."deliveries" (
	"subscriber" text,
	"event_id" uuid,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"delivered_at" timestamp(3) with time zone,
	CONSTRAINT "deliveries_pkey" PRIMARY KEY("subscriber","event_id"),
	CONSTRAINT "deliveries_status_check" CHECK ("status" in ('pending', 'delivered', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "events"."events" (
	"id" uuid PRIMARY KEY,
	"type" text NOT NULL,
	"producer" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"occurred_at" timestamp(3) with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"request_id" text,
	"traceparent" text,
	CONSTRAINT "events_payload_size_check" CHECK (octet_length("payload"::text) <= 65536)
);
--> statement-breakpoint
CREATE INDEX "deliveries_due_idx" ON "events"."deliveries" ("available_at","event_id") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "deliveries_subscriber_type_status_idx" ON "events"."deliveries" ("subscriber","type","status");--> statement-breakpoint
CREATE INDEX "deliveries_event_id_idx" ON "events"."deliveries" ("event_id");--> statement-breakpoint
CREATE INDEX "events_type_occurred_at_idx" ON "events"."events" ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "events_occurred_at_idx" ON "events"."events" ("occurred_at");--> statement-breakpoint
ALTER TABLE "events"."deliveries" ADD CONSTRAINT "deliveries_event_id_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"."events"("id") ON DELETE CASCADE;