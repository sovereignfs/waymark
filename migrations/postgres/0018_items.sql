CREATE TABLE "waymark"."item" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"day_id" text NOT NULL,
	"place_id" text,
	"kind" text DEFAULT 'other' NOT NULL,
	"start_time" text,
	"end_time" text,
	"fixed" boolean DEFAULT false NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"sealed" "bytea" NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "item_trip_idx" ON "waymark"."item" USING btree ("trip_id","seq");--> statement-breakpoint
CREATE INDEX "item_day_idx" ON "waymark"."item" USING btree ("day_id","position");--> statement-breakpoint
CREATE INDEX "item_place_idx" ON "waymark"."item" USING btree ("place_id");