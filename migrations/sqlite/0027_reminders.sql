CREATE TABLE `reminder_pref` (
	`trip_id` text NOT NULL,
	`account_id` text NOT NULL,
	`trip_starts` integer DEFAULT true NOT NULL,
	`item_soon` integer DEFAULT true NOT NULL,
	`lead_min` integer DEFAULT 30 NOT NULL,
	`flexible` integer DEFAULT false NOT NULL,
	`day_plan` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`trip_id`, `account_id`)
);
--> statement-breakpoint
CREATE INDEX `reminder_pref_account_idx` ON `reminder_pref` (`account_id`);--> statement-breakpoint
CREATE TABLE `reminder_sent` (
	`trip_id` text NOT NULL,
	`account_id` text NOT NULL,
	`key` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`trip_id`, `account_id`, `key`)
);
--> statement-breakpoint
CREATE INDEX `reminder_sent_at_idx` ON `reminder_sent` (`sent_at`);