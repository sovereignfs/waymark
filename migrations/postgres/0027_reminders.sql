CREATE TABLE "waymark"."reminder_pref" (
	"trip_id" text NOT NULL,
	"account_id" text NOT NULL,
	"trip_starts" boolean DEFAULT true NOT NULL,
	"item_soon" boolean DEFAULT true NOT NULL,
	"lead_min" bigint DEFAULT 30 NOT NULL,
	"flexible" boolean DEFAULT false NOT NULL,
	"day_plan" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "reminder_pref_trip_id_account_id_pk" PRIMARY KEY("trip_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "waymark"."reminder_sent" (
	"trip_id" text NOT NULL,
	"account_id" text NOT NULL,
	"key" text NOT NULL,
	"sent_at" bigint NOT NULL,
	CONSTRAINT "reminder_sent_trip_id_account_id_key_pk" PRIMARY KEY("trip_id","account_id","key")
);
--> statement-breakpoint
CREATE INDEX "reminder_pref_account_idx" ON "waymark"."reminder_pref" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "reminder_sent_at_idx" ON "waymark"."reminder_sent" USING btree ("sent_at");