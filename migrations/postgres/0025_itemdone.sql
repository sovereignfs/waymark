CREATE TABLE "waymark"."item_done" (
	"trip_id" text NOT NULL,
	"item_id" text NOT NULL,
	"account_id" text NOT NULL,
	"done_at" bigint NOT NULL,
	CONSTRAINT "item_done_trip_id_item_id_account_id_pk" PRIMARY KEY("trip_id","item_id","account_id")
);
--> statement-breakpoint
CREATE INDEX "item_done_account_idx" ON "waymark"."item_done" USING btree ("account_id");