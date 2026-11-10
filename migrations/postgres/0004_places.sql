CREATE TABLE "waymark"."place" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"trip_id" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"tz" text,
	"country_code" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "place_account_idx" ON "waymark"."place" USING btree ("account_id","seq");--> statement-breakpoint
CREATE INDEX "place_trip_idx" ON "waymark"."place" USING btree ("trip_id","seq");