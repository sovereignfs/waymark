CREATE TABLE `trip_link` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`position` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`sealed` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trip_link_trip_idx` ON `trip_link` (`trip_id`,`position`);