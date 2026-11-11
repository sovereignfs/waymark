CREATE TABLE "waymark"."notice_seen" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notice_seen_expires_idx" ON "waymark"."notice_seen" USING btree ("expires_at");