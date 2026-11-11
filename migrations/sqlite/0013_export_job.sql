CREATE TABLE `export_job` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`claimed_until` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`ready_at` integer,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `export_job_account_idx` ON `export_job` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `export_job_status_idx` ON `export_job` (`status`,`claimed_until`);