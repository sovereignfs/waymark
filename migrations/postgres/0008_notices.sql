CREATE TABLE "waymark"."notice" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"trip_id" text,
	"read_at" bigint,
	"sealed" "bytea" NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notice_account_idx" ON "waymark"."notice" USING btree ("account_id","created_at");