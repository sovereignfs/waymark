CREATE TABLE `item_done` (
	`trip_id` text NOT NULL,
	`item_id` text NOT NULL,
	`account_id` text NOT NULL,
	`done_at` integer NOT NULL,
	PRIMARY KEY(`trip_id`, `item_id`, `account_id`)
);
--> statement-breakpoint
CREATE INDEX `item_done_account_idx` ON `item_done` (`account_id`);