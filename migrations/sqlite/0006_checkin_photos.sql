CREATE TABLE `checkin_photo` (
	`id` text PRIMARY KEY NOT NULL,
	`checkin_id` text NOT NULL,
	`account_id` text NOT NULL,
	`position` integer NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `checkin_photo_checkin_idx` ON `checkin_photo` (`checkin_id`,`position`);--> statement-breakpoint
CREATE INDEX `checkin_photo_account_idx` ON `checkin_photo` (`account_id`);