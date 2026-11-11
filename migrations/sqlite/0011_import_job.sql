CREATE TABLE `import_job` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'checkins' NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`file_bytes` integer DEFAULT 0 NOT NULL,
	`checkins_done` integer DEFAULT 0 NOT NULL,
	`checkins_skipped` integer DEFAULT 0 NOT NULL,
	`places_made` integer DEFAULT 0 NOT NULL,
	`photos_done` integer DEFAULT 0 NOT NULL,
	`photos_failed` integer DEFAULT 0 NOT NULL,
	`claimed_until` integer DEFAULT 0 NOT NULL,
	`sealed` blob,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `import_job_account_idx` ON `import_job` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `import_job_status_idx` ON `import_job` (`status`,`claimed_until`);