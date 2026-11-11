CREATE TABLE "waymark"."trip_link" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"sealed" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE INDEX "trip_link_trip_idx" ON "waymark"."trip_link" USING btree ("trip_id","position");