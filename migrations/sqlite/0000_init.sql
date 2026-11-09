CREATE TABLE `rate_bucket` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_bucket_window_idx` ON `rate_bucket` (`window_start`);