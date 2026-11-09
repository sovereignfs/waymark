CREATE SCHEMA "waymark";
--> statement-breakpoint
CREATE TABLE "waymark"."rate_bucket" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" bigint NOT NULL,
	"count" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_bucket_window_idx" ON "waymark"."rate_bucket" USING btree ("window_start");