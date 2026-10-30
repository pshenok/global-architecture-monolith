CREATE SCHEMA "sample_items";
--> statement-breakpoint
CREATE TABLE "sample_items"."sample_items" (
	"id" uuid PRIMARY KEY,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "sample_items_owner_id_name_key" UNIQUE("owner_id","name")
);
--> statement-breakpoint
CREATE INDEX "sample_items_owner_id_id_idx" ON "sample_items"."sample_items" ("owner_id","id");