CREATE TABLE `item` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`day_id` text NOT NULL,
	`place_id` text,
	`kind` text DEFAULT 'other' NOT NULL,
	`start_time` text,
	`end_time` text,
	`fixed` integer DEFAULT false NOT NULL,
	`position` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`updated_by` text,
	`sealed` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `item_trip_idx` ON `item` (`trip_id`,`seq`);--> statement-breakpoint
CREATE INDEX `item_day_idx` ON `item` (`day_id`,`position`);--> statement-breakpoint
CREATE INDEX `item_place_idx` ON `item` (`place_id`);