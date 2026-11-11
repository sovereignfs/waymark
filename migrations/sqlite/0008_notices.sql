CREATE TABLE `notice` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`trip_id` text,
	`read_at` integer,
	`sealed` blob NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notice_account_idx` ON `notice` (`account_id`,`created_at`);