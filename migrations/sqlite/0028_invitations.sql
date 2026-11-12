CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`role` text NOT NULL,
	`via` text NOT NULL,
	`invited_by` text,
	`target_account_id` text,
	`token_hash` text NOT NULL,
	`last_sent_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_by` text,
	`accepted_at` integer,
	`revoked_at` integer,
	`sealed` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitation_token_idx` ON `invitation` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invitation_trip_idx` ON `invitation` (`trip_id`);--> statement-breakpoint
CREATE INDEX `invitation_invited_by_idx` ON `invitation` (`invited_by`);--> statement-breakpoint
CREATE INDEX `invitation_target_idx` ON `invitation` (`target_account_id`);