CREATE TABLE `core_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`kind` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`claimed_until` integer DEFAULT 0 NOT NULL,
	`sealed` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `core_outbox_due_idx` ON `core_outbox` (`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `core_outbox_account_idx` ON `core_outbox` (`account_id`);