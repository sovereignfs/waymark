CREATE TABLE "waymark"."key_rotation" (
	"fingerprint" text PRIMARY KEY NOT NULL,
	"previous_fingerprint" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"phase" text DEFAULT '' NOT NULL,
	"after" text DEFAULT '' NOT NULL,
	"rewrapped" bigint DEFAULT 0 NOT NULL,
	"unopenable" bigint DEFAULT 0 NOT NULL,
	"started_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"finished_at" bigint
);
