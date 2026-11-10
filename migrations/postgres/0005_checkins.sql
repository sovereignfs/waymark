CREATE TABLE "waymark"."account_stream" (
	"account_id" text PRIMARY KEY NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waymark"."applied_mutation" (
	"account_id" text NOT NULL,
	"mutation_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"applied_at" bigint NOT NULL,
	CONSTRAINT "applied_mutation_account_id_mutation_id_pk" PRIMARY KEY("account_id","mutation_id")
);
--> statement-breakpoint
CREATE TABLE "waymark"."checkin" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"place_id" text NOT NULL,
	"at" bigint NOT NULL,
	"tz" text NOT NULL,
	"offset_min" bigint NOT NULL,
	"trip_id" text,
	"link_source" text,
	"share" text DEFAULT 'trip' NOT NULL,
	"source" text DEFAULT 'live' NOT NULL,
	"external_id" text,
	"version" bigint DEFAULT 1 NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waymark"."tombstone" (
	"account_id" text NOT NULL,
	"table_name" text NOT NULL,
	"row_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"deleted_at" bigint NOT NULL,
	CONSTRAINT "tombstone_account_id_table_name_row_id_pk" PRIMARY KEY("account_id","table_name","row_id")
);
--> statement-breakpoint
ALTER TABLE "waymark"."place" ADD COLUMN "unnamed" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "checkin_account_at_idx" ON "waymark"."checkin" USING btree ("account_id","at");--> statement-breakpoint
CREATE INDEX "checkin_account_seq_idx" ON "waymark"."checkin" USING btree ("account_id","seq");--> statement-breakpoint
CREATE INDEX "checkin_trip_idx" ON "waymark"."checkin" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "checkin_place_idx" ON "waymark"."checkin" USING btree ("place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checkin_external_idx" ON "waymark"."checkin" USING btree ("account_id","external_id");--> statement-breakpoint
CREATE INDEX "tombstone_account_seq_idx" ON "waymark"."tombstone" USING btree ("account_id","seq");