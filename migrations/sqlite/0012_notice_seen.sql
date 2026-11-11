CREATE TABLE `notice_seen` (
	`jti` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notice_seen_expires_idx` ON `notice_seen` (`expires_at`);