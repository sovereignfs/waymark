CREATE TABLE "waymark"."push_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"subscription_id" text NOT NULL,
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"claimed_until" bigint DEFAULT 0 NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waymark"."push_subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"endpoint_hash" text NOT NULL,
	"last_ok_at" bigint,
	"sealed" "bytea" NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "push_outbox_due_idx" ON "waymark"."push_outbox" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "push_outbox_subscription_idx" ON "waymark"."push_outbox" USING btree ("subscription_id");--> statement-breakpoint
CREATE INDEX "push_outbox_account_idx" ON "waymark"."push_outbox" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscription_endpoint_idx" ON "waymark"."push_subscription" USING btree ("account_id","endpoint_hash");--> statement-breakpoint
CREATE INDEX "push_subscription_account_idx" ON "waymark"."push_subscription" USING btree ("account_id");