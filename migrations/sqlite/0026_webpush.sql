CREATE TABLE `push_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`claimed_until` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `push_outbox_due_idx` ON `push_outbox` (`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `push_outbox_subscription_idx` ON `push_outbox` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `push_outbox_account_idx` ON `push_outbox` (`account_id`);--> statement-breakpoint
CREATE TABLE `push_subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`endpoint_hash` text NOT NULL,
	`last_ok_at` integer,
	`sealed` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscription_endpoint_idx` ON `push_subscription` (`account_id`,`endpoint_hash`);--> statement-breakpoint
CREATE INDEX `push_subscription_account_idx` ON `push_subscription` (`account_id`);