CREATE TABLE "waymark"."attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"day_id" text,
	"kind" text DEFAULT 'other' NOT NULL,
	"media_id" text NOT NULL,
	"thumb_id" text,
	"seq" bigint DEFAULT 0 NOT NULL,
	"created_by" text,
	"sealed" "bytea" NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "attachment_trip_idx" ON "waymark"."attachment" USING btree ("trip_id","seq");--> statement-breakpoint
CREATE INDEX "attachment_day_idx" ON "waymark"."attachment" USING btree ("day_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_media_idx" ON "waymark"."attachment" USING btree ("media_id");