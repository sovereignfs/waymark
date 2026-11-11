CREATE TABLE `notice_pref` (
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`channel` text NOT NULL,
	`enabled` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `kind`, `channel`)
);
