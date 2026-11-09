CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`trip_id` text,
	`kind` text NOT NULL,
	`type` text NOT NULL,
	`bytes` integer NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_account_idx` ON `media` (`account_id`);--> statement-breakpoint
CREATE INDEX `media_trip_idx` ON `media` (`trip_id`);