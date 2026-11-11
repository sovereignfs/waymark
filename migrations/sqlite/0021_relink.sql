CREATE TABLE `relink` (
	`trip_id` text PRIMARY KEY NOT NULL,
	`requested_at` integer NOT NULL,
	`claimed_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `relink_due_idx` ON `relink` (`claimed_until`,`requested_at`);