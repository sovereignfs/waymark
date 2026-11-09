CREATE TABLE "waymark"."media" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"trip_id" text,
	"kind" text NOT NULL,
	"type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "media_account_idx" ON "waymark"."media" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "media_trip_idx" ON "waymark"."media" USING btree ("trip_id");