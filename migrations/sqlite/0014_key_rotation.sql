CREATE TABLE `key_rotation` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`previous_fingerprint` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`phase` text DEFAULT '' NOT NULL,
	`after` text DEFAULT '' NOT NULL,
	`rewrapped` integer DEFAULT 0 NOT NULL,
	`unopenable` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
