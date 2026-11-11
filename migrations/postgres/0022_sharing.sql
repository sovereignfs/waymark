CREATE TABLE "waymark"."shared_checkin" (
	"checkin_id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"account_id" text NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"sealed" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE INDEX "shared_checkin_trip_idx" ON "waymark"."shared_checkin" USING btree ("trip_id","seq");--> statement-breakpoint
CREATE INDEX "shared_checkin_account_idx" ON "waymark"."shared_checkin" USING btree ("account_id");