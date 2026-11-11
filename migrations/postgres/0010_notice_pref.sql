CREATE TABLE "waymark"."notice_pref" (
	"account_id" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"enabled" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "notice_pref_account_id_kind_channel_pk" PRIMARY KEY("account_id","kind","channel")
);
