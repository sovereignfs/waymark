CREATE TABLE "waymark"."day" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"stop_id" text NOT NULL,
	"date" text NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"sealed" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waymark"."stop" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"place_id" text NOT NULL,
	"arrive" text,
	"depart" text,
	"position" text COLLATE "C" NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "day_trip_idx" ON "waymark"."day" USING btree ("trip_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "day_stop_date_idx" ON "waymark"."day" USING btree ("stop_id","date");--> statement-breakpoint
CREATE INDEX "stop_trip_idx" ON "waymark"."stop" USING btree ("trip_id","seq");--> statement-breakpoint
CREATE INDEX "stop_place_idx" ON "waymark"."stop" USING btree ("place_id");