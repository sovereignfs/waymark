CREATE TABLE "waymark"."trip_tombstone" (
	"trip_id" text NOT NULL,
	"table_name" text NOT NULL,
	"row_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"deleted_at" bigint NOT NULL,
	CONSTRAINT "trip_tombstone_trip_id_table_name_row_id_pk" PRIMARY KEY("trip_id","table_name","row_id")
);
--> statement-breakpoint
ALTER TABLE "waymark"."trip" ADD COLUMN "floor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "trip_tombstone_seq_idx" ON "waymark"."trip_tombstone" USING btree ("trip_id","seq");