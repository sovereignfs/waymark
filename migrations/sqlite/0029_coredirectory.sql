CREATE TABLE `core_token` (
	`sub` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`lock_until` integer DEFAULT 0 NOT NULL,
	`sealed` blob NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `core_token_account_idx` ON `core_token` (`account_id`);--> statement-breakpoint
ALTER TABLE `invitation` ADD `target_sub` text;--> statement-breakpoint
CREATE INDEX `invitation_target_sub_idx` ON `invitation` (`target_sub`);