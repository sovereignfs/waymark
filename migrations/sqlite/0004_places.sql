CREATE TABLE `place` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`trip_id` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`tz` text,
	`country_code` text,
	`version` integer DEFAULT 1 NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`sealed` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `place_account_idx` ON `place` (`account_id`,`seq`);--> statement-breakpoint
CREATE INDEX `place_trip_idx` ON `place` (`trip_id`,`seq`);