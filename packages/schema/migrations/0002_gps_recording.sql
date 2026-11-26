CREATE TABLE `best_effort` (
	`session_id` text NOT NULL,
	`effort` text NOT NULL,
	`elapsed_ms` integer NOT NULL,
	`moving_ms` integer NOT NULL,
	`start_offset_ms` integer NOT NULL,
	`ascent_mm` integer,
	`algorithm_version` integer NOT NULL,
	PRIMARY KEY(`session_id`, `effort`),
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "best_effort_ascent_kind" CHECK(("best_effort"."effort" LIKE '%:ascent_1h') = ("best_effort"."ascent_mm" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `best_effort_rank` ON `best_effort` (`effort`,`elapsed_ms`);--> statement-breakpoint
CREATE INDEX `best_effort_ascent` ON `best_effort` (`effort`,`ascent_mm`) WHERE "best_effort"."ascent_mm" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `lap` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`trigger` text NOT NULL,
	`start_offset_ms` integer NOT NULL,
	`end_offset_ms` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lap_bounds" CHECK("lap"."start_offset_ms" >= 0 AND "lap"."end_offset_ms" > "lap"."start_offset_ms")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lap_position` ON `lap` (`session_id`,`position`);--> statement-breakpoint
CREATE TABLE `privacy_zone` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`latitude_e7` integer NOT NULL,
	`longitude_e7` integer NOT NULL,
	`radius_meters` integer NOT NULL,
	`mask_scale_permille` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "privacy_zone_radius" CHECK("privacy_zone"."radius_meters" BETWEEN 100 AND 2000),
	CONSTRAINT "privacy_zone_mask" CHECK("privacy_zone"."mask_scale_permille" BETWEEN 1000 AND 1300),
	CONSTRAINT "privacy_zone_position" CHECK("privacy_zone"."latitude_e7" BETWEEN -900000000 AND 900000000 AND "privacy_zone"."longitude_e7" BETWEEN -1800000000 AND 1800000000)
);
--> statement-breakpoint
CREATE TABLE `recording` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`source` text NOT NULL,
	`import_format` text,
	`external_id` text,
	`device` text NOT NULL,
	`algorithm_version` integer NOT NULL,
	`auto_pause` integer NOT NULL,
	`elevation_source` text NOT NULL,
	`cadence_source` text NOT NULL,
	`heart_rate_source` text NOT NULL,
	`simulated` integer NOT NULL,
	`trim_start_ms` integer NOT NULL,
	`trim_end_ms` integer,
	`elapsed_ms` integer NOT NULL,
	`moving_ms` integer NOT NULL,
	`distance_mm` integer NOT NULL,
	`ascent_mm` integer,
	`descent_mm` integer,
	`altitude_min_mm` integer,
	`altitude_max_mm` integer,
	`speed_max_mm_s` integer,
	`cadence_avg` integer,
	`steps` integer,
	`heart_rate_avg` integer,
	`heart_rate_max` integer,
	`heart_rate_device` text,
	`energy_kcal` integer,
	`energy_method` text,
	`imported_energy_kcal` integer,
	`weather` text,
	`good_fix_permille` integer NOT NULL,
	`bbox` text,
	`preview_polyline` text,
	`track_file` text,
	`track_sha256` text,
	`track_bytes` integer,
	`point_count` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "recording_times" CHECK("recording"."moving_ms" BETWEEN 0 AND "recording"."elapsed_ms"),
	CONSTRAINT "recording_trim" CHECK("recording"."trim_start_ms" >= 0 AND ("recording"."trim_end_ms" IS NULL OR "recording"."trim_end_ms" > "recording"."trim_start_ms")),
	CONSTRAINT "recording_import" CHECK(("recording"."source" = 'import') = ("recording"."import_format" IS NOT NULL)),
	CONSTRAINT "recording_track" CHECK(("recording"."track_file" IS NULL) = ("recording"."track_sha256" IS NULL) AND ("recording"."track_file" IS NULL) = ("recording"."track_bytes" IS NULL)),
	CONSTRAINT "recording_distance" CHECK("recording"."distance_mm" >= 0 AND "recording"."point_count" >= 0),
	CONSTRAINT "recording_good_fix" CHECK("recording"."good_fix_permille" BETWEEN 0 AND 1000),
	CONSTRAINT "recording_energy" CHECK(("recording"."energy_kcal" IS NULL) = ("recording"."energy_method" IS NULL) AND ("recording"."energy_kcal" IS NULL OR "recording"."energy_kcal" BETWEEN 0 AND 30000))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recording_session` ON `recording` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `recording_external` ON `recording` (`external_id`) WHERE "recording"."external_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `segment` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`family` text NOT NULL,
	`polyline` text NOT NULL,
	`distance_mm` integer NOT NULL,
	`ascent_mm` integer NOT NULL,
	`bbox` text NOT NULL,
	`south` integer NOT NULL,
	`north` integer NOT NULL,
	`source_session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`source_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "segment_distance" CHECK("segment"."distance_mm" >= 100000)
);
--> statement-breakpoint
CREATE INDEX `segment_bbox` ON `segment` (`family`,`south`,`north`);--> statement-breakpoint
CREATE TABLE `segment_effort` (
	`segment_id` text NOT NULL,
	`session_id` text NOT NULL,
	`occurrence` integer NOT NULL,
	`start_offset_ms` integer NOT NULL,
	`elapsed_ms` integer NOT NULL,
	`moving_ms` integer NOT NULL,
	`heart_rate_avg` integer,
	`algorithm_version` integer NOT NULL,
	PRIMARY KEY(`segment_id`, `session_id`, `occurrence`),
	FOREIGN KEY (`segment_id`) REFERENCES `segment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `segment_effort_rank` ON `segment_effort` (`segment_id`,`elapsed_ms`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`theme` text NOT NULL,
	`mass_unit` text NOT NULL,
	`agent_can_read_body` integer NOT NULL,
	`agent_can_write` integer NOT NULL,
	`agent_can_read_photos` integer NOT NULL,
	`reminder_weekdays` integer NOT NULL,
	`reminder_minutes` integer NOT NULL,
	`reminders_exported_at` integer,
	`agent_changes_seen_at` integer,
	`bridge_host` text,
	`rest_alerts_declined_at` integer,
	`rest_alerts_asked_at` integer,
	`agent_can_read_location` integer DEFAULT true NOT NULL,
	`keep_screen_on` integer DEFAULT false NOT NULL,
	`countdown` integer DEFAULT false NOT NULL,
	`map_style` text DEFAULT 'obnixe_outdoor' NOT NULL,
	`map_cache_megabytes` integer DEFAULT 200 NOT NULL,
	`export_privacy` integer DEFAULT true NOT NULL,
	`hide_track_ends_meters` integer DEFAULT 0 NOT NULL,
	`birth_year` integer,
	`sex` text,
	`max_heart_rate` integer,
	`weather_enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "settings_singleton" CHECK("__new_settings"."singleton" = 1),
	CONSTRAINT "settings_reminder_weekdays" CHECK("__new_settings"."reminder_weekdays" BETWEEN 0 AND 127),
	CONSTRAINT "settings_reminder_minutes" CHECK("__new_settings"."reminder_minutes" BETWEEN 0 AND 1439),
	CONSTRAINT "settings_map_cache" CHECK("__new_settings"."map_cache_megabytes" > 0),
	CONSTRAINT "settings_hide_track_ends" CHECK("__new_settings"."hide_track_ends_meters" BETWEEN 0 AND 1000),
	CONSTRAINT "settings_birth_year" CHECK("__new_settings"."birth_year" IS NULL OR "__new_settings"."birth_year" BETWEEN 1900 AND 2100),
	CONSTRAINT "settings_max_heart_rate" CHECK("__new_settings"."max_heart_rate" IS NULL OR "__new_settings"."max_heart_rate" BETWEEN 120 AND 230)
);
--> statement-breakpoint
INSERT INTO `__new_settings`("singleton", "theme", "mass_unit", "agent_can_read_body", "agent_can_write", "agent_can_read_photos", "reminder_weekdays", "reminder_minutes", "reminders_exported_at", "agent_changes_seen_at", "bridge_host", "rest_alerts_declined_at", "rest_alerts_asked_at", "updated_at") SELECT "singleton", "theme", "mass_unit", "agent_can_read_body", "agent_can_write", "agent_can_read_photos", "reminder_weekdays", "reminder_minutes", "reminders_exported_at", "agent_changes_seen_at", "bridge_host", "rest_alerts_declined_at", "rest_alerts_asked_at", "updated_at" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `sport_preference` ADD `recording_settings` text;