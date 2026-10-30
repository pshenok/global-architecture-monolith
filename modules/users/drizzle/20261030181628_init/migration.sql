CREATE SCHEMA "users";
--> statement-breakpoint
CREATE TABLE "users"."identities" (
	"issuer" text,
	"subject" text,
	"user_id" uuid NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "identities_pkey" PRIMARY KEY("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "users"."users" (
	"id" uuid PRIMARY KEY,
	"email" text CONSTRAINT "users_email_key" UNIQUE,
	"full_name" text NOT NULL,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "users_roles_check" CHECK ("roles" <@ ARRAY['admin']::text[])
);
--> statement-breakpoint
CREATE INDEX "identities_user_id_idx" ON "users"."identities" ("user_id");--> statement-breakpoint
ALTER TABLE "users"."identities" ADD CONSTRAINT "identities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"."users"("id") ON DELETE CASCADE;