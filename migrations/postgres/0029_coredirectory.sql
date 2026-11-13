CREATE TABLE "waymark"."core_token" (
	"sub" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"lock_until" bigint DEFAULT 0 NOT NULL,
	"sealed" "bytea" NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waymark"."invitation" ADD COLUMN "target_sub" text;--> statement-breakpoint
CREATE INDEX "core_token_account_idx" ON "waymark"."core_token" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "invitation_target_sub_idx" ON "waymark"."invitation" USING btree ("target_sub");