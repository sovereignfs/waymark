CREATE TABLE `attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`day_id` text,
	`kind` text DEFAULT 'other' NOT NULL,
	`media_id` text NOT NULL,
	`thumb_id` text,
	`seq` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`sealed` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attachment_trip_idx` ON `attachment` (`trip_id`,`seq`);--> statement-breakpoint
CREATE INDEX `attachment_day_idx` ON `attachment` (`day_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachment_media_idx` ON `attachment` (`media_id`);