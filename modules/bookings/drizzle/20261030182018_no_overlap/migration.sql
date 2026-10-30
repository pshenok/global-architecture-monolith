-- No two CONFIRMED bookings of the same house may overlap: [check_in, check_out)
-- ranges are compared with &&, so back-to-back stays (check_out = next check_in)
-- are allowed. Enforced atomically by Postgres, so concurrent requests for the
-- same dates cannot both succeed. Violations raise 23P01 on "bookings_no_overlap",
-- which the repository maps to BOOKING_DATES_UNAVAILABLE (409).
-- btree_gist provides the gist operator class for uuid equality. It is a trusted
-- extension (the database owner may create it); `pnpm db:setup` pre-creates it locally.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
--> statement-breakpoint
ALTER TABLE "bookings"."bookings" ADD CONSTRAINT "bookings_no_overlap"
  EXCLUDE USING gist ("house_id" WITH =, daterange("check_in", "check_out", '[)') WITH &&)
  WHERE ("status" = 'CONFIRMED');
