CREATE TABLE "waymark"."invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"role" text NOT NULL,
	"via" text NOT NULL,
	"invited_by" text,
	"target_account_id" text,
	"token_hash" text NOT NULL,
	"last_sent_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"accepted_by" text,
	"accepted_at" bigint,
	"revoked_at" bigint,
	"sealed" "bytea" NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_token_idx" ON "waymark"."invitation" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "invitation_trip_idx" ON "waymark"."invitation" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "invitation_invited_by_idx" ON "waymark"."invitation" USING btree ("invited_by");--> statement-breakpoint
CREATE INDEX "invitation_target_idx" ON "waymark"."invitation" USING btree ("target_account_id");