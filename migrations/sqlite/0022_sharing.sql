CREATE TABLE `shared_checkin` (
	`checkin_id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`account_id` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`sealed` blob NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shared_checkin_trip_idx` ON `shared_checkin` (`trip_id`,`seq`);--> statement-breakpoint
CREATE INDEX `shared_checkin_account_idx` ON `shared_checkin` (`account_id`);