CREATE TABLE "waymark"."export_job" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"claimed_until" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"ready_at" bigint,
	"expires_at" bigint
);
--> statement-breakpoint
CREATE INDEX "export_job_account_idx" ON "waymark"."export_job" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "export_job_status_idx" ON "waymark"."export_job" USING btree ("status","claimed_until");