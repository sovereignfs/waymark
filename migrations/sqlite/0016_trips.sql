CREATE TABLE `trip` (
	`id` text PRIMARY KEY NOT NULL,
	`color` text NOT NULL,
	`start_date` text,
	`end_date` text,
	`ready_at` integer,
	`cover_place_id` text,
	`seq` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`sealed` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trip_dates_idx` ON `trip` (`start_date`,`id`);--> statement-breakpoint
CREATE TABLE `trip_member` (
	`trip_id` text NOT NULL,
	`account_id` text NOT NULL,
	`role` text NOT NULL,
	`going` integer DEFAULT true NOT NULL,
	`share_checkins` text DEFAULT 'ask' NOT NULL,
	`added_by` text,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`trip_id`, `account_id`)
);
--> statement-breakpoint
CREATE INDEX `trip_member_account_idx` ON `trip_member` (`account_id`);