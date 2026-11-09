CREATE TABLE `profile` (
	`account_id` text PRIMARY KEY NOT NULL,
	`core_sub` text,
	`units` text DEFAULT 'km' NOT NULL,
	`week_start` integer DEFAULT 1 NOT NULL,
	`share_default` text DEFAULT 'ask' NOT NULL,
	`sealed` blob NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
