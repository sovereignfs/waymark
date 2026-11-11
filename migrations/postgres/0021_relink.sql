CREATE TABLE "waymark"."relink" (
	"trip_id" text PRIMARY KEY NOT NULL,
	"requested_at" bigint NOT NULL,
	"claimed_until" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "relink_due_idx" ON "waymark"."relink" USING btree ("claimed_until","requested_at");