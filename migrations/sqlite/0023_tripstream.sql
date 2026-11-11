CREATE TABLE `trip_tombstone` (
	`trip_id` text NOT NULL,
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`seq` integer NOT NULL,
	`deleted_at` integer NOT NULL,
	PRIMARY KEY(`trip_id`, `table_name`, `row_id`)
);
--> statement-breakpoint
CREATE INDEX `trip_tombstone_seq_idx` ON `trip_tombstone` (`trip_id`,`seq`);--> statement-breakpoint
ALTER TABLE `trip` ADD `floor` integer DEFAULT 0 NOT NULL;