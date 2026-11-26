CREATE TABLE `recording_derivation` (
	`session_id` text PRIMARY KEY NOT NULL,
	`session_updated_at` integer NOT NULL,
	`recording_updated_at` integer NOT NULL,
	`algorithm_version` integer NOT NULL,
	`mask_key` text NOT NULL,
	`start_latitude_e7` integer,
	`start_longitude_e7` integer,
	`end_latitude_e7` integer,
	`end_longitude_e7` integer,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "recording_derivation_ends" CHECK(("recording_derivation"."start_latitude_e7" IS NULL) = ("recording_derivation"."start_longitude_e7" IS NULL) AND ("recording_derivation"."start_latitude_e7" IS NULL) = ("recording_derivation"."end_latitude_e7" IS NULL) AND ("recording_derivation"."start_latitude_e7" IS NULL) = ("recording_derivation"."end_longitude_e7" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `zone_proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`latitude_e7` integer NOT NULL,
	`longitude_e7` integer NOT NULL,
	`proposed_at` integer NOT NULL
);
