CREATE TABLE "waymark"."trip" (
	"id" text PRIMARY KEY NOT NULL,
	"color" text NOT NULL,
	"start_date" text,
	"end_date" text,
	"ready_at" bigint,
	"cover_place_id" text,
	"seq" bigint DEFAULT 0 NOT NULL,
	"created_by" text,
	"sealed" "bytea" NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waymark"."trip_member" (
	"trip_id" text NOT NULL,
	"account_id" text NOT NULL,
	"role" text NOT NULL,
	"going" boolean DEFAULT true NOT NULL,
	"share_checkins" text DEFAULT 'ask' NOT NULL,
	"added_by" text,
	"joined_at" bigint NOT NULL,
	"left_at" bigint,
	"seq" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "trip_member_trip_id_account_id_pk" PRIMARY KEY("trip_id","account_id")
);
--> statement-breakpoint
CREATE INDEX "trip_dates_idx" ON "waymark"."trip" USING btree ("start_date","id");--> statement-breakpoint
CREATE INDEX "trip_member_account_idx" ON "waymark"."trip_member" USING btree ("account_id");