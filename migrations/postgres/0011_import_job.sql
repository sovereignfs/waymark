CREATE TABLE "waymark"."import_job" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'checkins' NOT NULL,
	"cursor" bigint DEFAULT 0 NOT NULL,
	"file_bytes" bigint DEFAULT 0 NOT NULL,
	"checkins_done" bigint DEFAULT 0 NOT NULL,
	"checkins_skipped" bigint DEFAULT 0 NOT NULL,
	"places_made" bigint DEFAULT 0 NOT NULL,
	"photos_done" bigint DEFAULT 0 NOT NULL,
	"photos_failed" bigint DEFAULT 0 NOT NULL,
	"claimed_until" bigint DEFAULT 0 NOT NULL,
	"sealed" "bytea",
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE INDEX "import_job_account_idx" ON "waymark"."import_job" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "import_job_status_idx" ON "waymark"."import_job" USING btree ("status","claimed_until");