CREATE TABLE "waymark"."checkin_photo" (
	"id" text PRIMARY KEY NOT NULL,
	"checkin_id" text NOT NULL,
	"account_id" text NOT NULL,
	"position" bigint NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "checkin_photo_checkin_idx" ON "waymark"."checkin_photo" USING btree ("checkin_id","position");--> statement-breakpoint
CREATE INDEX "checkin_photo_account_idx" ON "waymark"."checkin_photo" USING btree ("account_id");