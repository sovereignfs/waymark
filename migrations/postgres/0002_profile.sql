CREATE TABLE "waymark"."profile" (
	"account_id" text PRIMARY KEY NOT NULL,
	"core_sub" text,
	"units" text DEFAULT 'km' NOT NULL,
	"week_start" bigint DEFAULT 1 NOT NULL,
	"share_default" text DEFAULT 'ask' NOT NULL,
	"sealed" "bytea" NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
