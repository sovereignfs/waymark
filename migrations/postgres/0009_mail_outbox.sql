CREATE TABLE "waymark"."mail_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text,
	"kind" text NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"claimed_until" bigint DEFAULT 0 NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mail_outbox_due_idx" ON "waymark"."mail_outbox" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "mail_outbox_account_idx" ON "waymark"."mail_outbox" USING btree ("account_id");