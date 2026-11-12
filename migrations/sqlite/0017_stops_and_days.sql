CREATE TABLE `day` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`stop_id` text NOT NULL,
	`date` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`sealed` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `day_trip_idx` ON `day` (`trip_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `day_stop_date_idx` ON `day` (`stop_id`,`date`);--> statement-breakpoint
CREATE TABLE `stop` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`place_id` text NOT NULL,
	`arrive` text,
	`depart` text,
	`position` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`sealed` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stop_trip_idx` ON `stop` (`trip_id`,`seq`);--> statement-breakpoint
CREATE INDEX `stop_place_idx` ON `stop` (`place_id`);