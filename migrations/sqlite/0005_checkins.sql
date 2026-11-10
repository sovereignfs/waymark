CREATE TABLE `account_stream` (
	`account_id` text PRIMARY KEY NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `applied_mutation` (
	`account_id` text NOT NULL,
	`mutation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`applied_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `mutation_id`)
);
--> statement-breakpoint
CREATE TABLE `checkin` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`place_id` text NOT NULL,
	`at` integer NOT NULL,
	`tz` text NOT NULL,
	`offset_min` integer NOT NULL,
	`trip_id` text,
	`link_source` text,
	`share` text DEFAULT 'trip' NOT NULL,
	`source` text DEFAULT 'live' NOT NULL,
	`external_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`sealed` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `checkin_account_at_idx` ON `checkin` (`account_id`,`at`);--> statement-breakpoint
CREATE INDEX `checkin_account_seq_idx` ON `checkin` (`account_id`,`seq`);--> statement-breakpoint
CREATE INDEX `checkin_trip_idx` ON `checkin` (`trip_id`);--> statement-breakpoint
CREATE INDEX `checkin_place_idx` ON `checkin` (`place_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `checkin_external_idx` ON `checkin` (`account_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `tombstone` (
	`account_id` text NOT NULL,
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`seq` integer NOT NULL,
	`deleted_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `table_name`, `row_id`)
);
--> statement-breakpoint
CREATE INDEX `tombstone_account_seq_idx` ON `tombstone` (`account_id`,`seq`);--> statement-breakpoint
ALTER TABLE `place` ADD `unnamed` integer DEFAULT 0 NOT NULL;