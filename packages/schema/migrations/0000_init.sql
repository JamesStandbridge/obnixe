CREATE TABLE `check_in` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`local_date` text NOT NULL,
	`time_zone` text NOT NULL,
	`energy` integer,
	`sleep` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "check_in_energy" CHECK("check_in"."energy" IS NULL OR "check_in"."energy" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `check_in_day` ON `check_in` (`local_date`) WHERE "check_in"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `measurement` (
	`id` text PRIMARY KEY NOT NULL,
	`kind_id` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`local_date` text NOT NULL,
	`time_zone` text NOT NULL,
	`millimeters` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`kind_id`) REFERENCES `measurement_kind`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "measurement_positive" CHECK("measurement"."millimeters" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `measurement_day` ON `measurement` (`kind_id`,`local_date`) WHERE "measurement"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `measurement_kind` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`zone` text,
	`position` integer NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `measurement_kind_label` ON `measurement_kind` (lower("label"));--> statement-breakpoint
CREATE TABLE `photo` (
	`id` text PRIMARY KEY NOT NULL,
	`pose` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`local_date` text NOT NULL,
	`time_zone` text NOT NULL,
	`file` text NOT NULL,
	`sha256` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `photo_day` ON `photo` (`local_date`);--> statement-breakpoint
CREATE TABLE `weigh_in` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`local_date` text NOT NULL,
	`time_zone` text NOT NULL,
	`grams` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "weigh_in_grams" CHECK("weigh_in"."grams" BETWEEN 20000 AND 400000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weigh_in_day` ON `weigh_in` (`local_date`) WHERE "weigh_in"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `exercise` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`measure` text NOT NULL,
	`equipment` text NOT NULL,
	`load_mode` text NOT NULL,
	`base_grams` integer,
	`load_step_grams` integer,
	`zones_reviewed` integer NOT NULL,
	`cues` text,
	`merged_into_id` text,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`merged_into_id`) REFERENCES `exercise`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "exercise_merged" CHECK("exercise"."merged_into_id" IS NULL OR ("exercise"."merged_into_id" <> "exercise"."id" AND "exercise"."archived_at" IS NOT NULL)),
	CONSTRAINT "exercise_load_step" CHECK("exercise"."load_step_grams" IS NULL OR ("exercise"."measure" <> 'duration' AND "exercise"."load_step_grams" > 0)),
	CONSTRAINT "exercise_load_mode" CHECK("exercise"."load_mode" = 'total' OR "exercise"."measure" <> 'duration'),
	CONSTRAINT "exercise_base" CHECK("exercise"."base_grams" IS NULL OR ("exercise"."load_mode" = 'per_side' AND "exercise"."base_grams" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_name_key` ON `exercise` (`name_key`) WHERE "exercise"."merged_into_id" IS NULL;--> statement-breakpoint
CREATE TABLE `exercise_zone` (
	`exercise_id` text NOT NULL,
	`zone` text NOT NULL,
	PRIMARY KEY(`exercise_id`, `zone`),
	FOREIGN KEY (`exercise_id`) REFERENCES `exercise`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `exercise_zone_zone` ON `exercise_zone` (`zone`);--> statement-breakpoint
CREATE TABLE `agent_call` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`tool` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`changeset_id` text,
	`called_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `agent_connection`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changeset_id`) REFERENCES `changeset`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_call_write" CHECK("agent_call"."changeset_id" IS NULL OR "agent_call"."kind" = 'write')
);
--> statement-breakpoint
CREATE INDEX `agent_call_connection` ON `agent_call` (`connection_id`,`called_at`);--> statement-breakpoint
CREATE TABLE `agent_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`client` text NOT NULL,
	`host` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	CONSTRAINT "agent_connection_end" CHECK(("agent_connection"."ended_at" IS NULL) = ("agent_connection"."end_reason" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `agent_connection_started` ON `agent_connection` (`started_at`);--> statement-breakpoint
CREATE TABLE `change` (
	`changeset_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`operation` text NOT NULL,
	`before` text,
	`after` text,
	PRIMARY KEY(`changeset_id`, `sequence`),
	FOREIGN KEY (`changeset_id`) REFERENCES `changeset`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "change_images" CHECK(("change"."operation" = 'insert' AND "change"."before" IS NULL AND "change"."after" IS NOT NULL) OR ("change"."operation" = 'update' AND "change"."before" IS NOT NULL AND "change"."after" IS NOT NULL) OR ("change"."operation" = 'delete' AND "change"."before" IS NOT NULL AND "change"."after" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `change_row` ON `change` (`table_name`,`row_id`);--> statement-breakpoint
CREATE TABLE `changeset` (
	`id` text PRIMARY KEY NOT NULL,
	`author` text NOT NULL,
	`connection_id` text,
	`summary` text NOT NULL,
	`reverts_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `agent_connection`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "changeset_agent" CHECK(("changeset"."author" = 'agent') = ("changeset"."connection_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `changeset_created` ON `changeset` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `changeset_reverts` ON `changeset` (`reverts_id`);--> statement-breakpoint
CREATE TABLE `pain_report` (
	`id` text PRIMARY KEY NOT NULL,
	`zone` text NOT NULL,
	`level` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`local_date` text NOT NULL,
	`time_zone` text NOT NULL,
	`session_id` text,
	`phase` text,
	`strength_set_id` text,
	`session_item_id` text,
	`check_in_id` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`strength_set_id`) REFERENCES `strength_set`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_item_id`) REFERENCES `session_item`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`check_in_id`) REFERENCES `check_in`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "pain_report_source" CHECK(("pain_report"."session_id" IS NOT NULL AND "pain_report"."phase" IS NOT NULL AND "pain_report"."check_in_id" IS NULL) OR ("pain_report"."session_id" IS NULL AND "pain_report"."phase" IS NULL AND "pain_report"."strength_set_id" IS NULL AND "pain_report"."session_item_id" IS NULL AND "pain_report"."check_in_id" IS NOT NULL)),
	CONSTRAINT "pain_report_anchor" CHECK("pain_report"."strength_set_id" IS NULL OR "pain_report"."session_item_id" IS NULL),
	CONSTRAINT "pain_report_anchor_phase" CHECK(("pain_report"."strength_set_id" IS NULL AND "pain_report"."session_item_id" IS NULL) OR "pain_report"."phase" IN ('during', 'between'))
);
--> statement-breakpoint
CREATE INDEX `pain_report_zone` ON `pain_report` (`zone`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `pain_report_session` ON `pain_report` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pain_report_check_in_zone` ON `pain_report` (`check_in_id`,`zone`) WHERE "pain_report"."check_in_id" IS NOT NULL AND "pain_report"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `zone_tracking` (
	`id` text PRIMARY KEY NOT NULL,
	`zone` text NOT NULL,
	`reason` text NOT NULL,
	`pain_report_id` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`pain_report_id`) REFERENCES `pain_report`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "zone_tracking_interval" CHECK("zone_tracking"."ended_at" IS NULL OR "zone_tracking"."ended_at" >= "zone_tracking"."started_at"),
	CONSTRAINT "zone_tracking_origin" CHECK("zone_tracking"."pain_report_id" IS NULL OR "zone_tracking"."reason" = 'pain_reported')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zone_tracking_open` ON `zone_tracking` (`zone`) WHERE "zone_tracking"."ended_at" IS NULL;--> statement-breakpoint
CREATE TABLE `program` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_single_active` ON `program` (`status`) WHERE "program"."status" = 'active';--> statement-breakpoint
CREATE TABLE `program_item` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`lineage_id` text NOT NULL,
	`position` integer NOT NULL,
	`exercise_id` text NOT NULL,
	`sets` integer NOT NULL,
	`reps_min` integer,
	`reps_max` integer,
	`duration_min_seconds` integer,
	`duration_max_seconds` integer,
	`target_rir` integer,
	`rest_seconds` integer,
	`rest_after_seconds` integer,
	FOREIGN KEY (`variant_id`) REFERENCES `program_variant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercise`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "program_item_sets" CHECK("program_item"."sets" >= 1),
	CONSTRAINT "program_item_target" CHECK(("program_item"."reps_min" IS NOT NULL AND "program_item"."reps_max" >= "program_item"."reps_min" AND "program_item"."duration_min_seconds" IS NULL AND "program_item"."duration_max_seconds" IS NULL) OR ("program_item"."reps_min" IS NULL AND "program_item"."reps_max" IS NULL AND "program_item"."duration_min_seconds" IS NOT NULL AND "program_item"."duration_max_seconds" >= "program_item"."duration_min_seconds")),
	CONSTRAINT "program_item_rir" CHECK("program_item"."target_rir" IS NULL OR "program_item"."target_rir" BETWEEN 0 AND 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_item_position` ON `program_item` (`variant_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `program_item_lineage` ON `program_item` (`variant_id`,`lineage_id`);--> statement-breakpoint
CREATE INDEX `program_item_exercise` ON `program_item` (`exercise_id`);--> statement-breakpoint
CREATE TABLE `program_slot` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`lineage_id` text NOT NULL,
	`position` integer NOT NULL,
	`sport` text NOT NULL,
	`name` text NOT NULL,
	`target_duration_seconds` integer,
	`target_effort` text,
	`target_values` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `program_version`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_slot_position` ON `program_slot` (`version_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `program_slot_lineage` ON `program_slot` (`version_id`,`lineage_id`);--> statement-breakpoint
CREATE TABLE `program_variant` (
	`id` text PRIMARY KEY NOT NULL,
	`slot_id` text NOT NULL,
	`lineage_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`slot_id`) REFERENCES `program_slot`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_variant_position` ON `program_variant` (`slot_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `program_variant_lineage` ON `program_variant` (`slot_id`,`lineage_id`);--> statement-breakpoint
CREATE TABLE `program_version` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`number` integer NOT NULL,
	`name` text NOT NULL,
	`sessions_per_week` integer NOT NULL,
	`copied_from_id` text,
	`summary` text,
	`reason` text,
	`changeset_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `program`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`copied_from_id`) REFERENCES `program_version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changeset_id`) REFERENCES `changeset`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "program_version_number_positive" CHECK("program_version"."number" >= 1),
	CONSTRAINT "program_version_frequency" CHECK("program_version"."sessions_per_week" BETWEEN 1 AND 14)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_version_number` ON `program_version` (`program_id`,`number`);--> statement-breakpoint
CREATE TABLE `rotation_skip` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`slot_lineage_id` text NOT NULL,
	`skipped_at` integer NOT NULL,
	`local_date` text NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `program`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rotation_skip_program` ON `rotation_skip` (`program_id`,`skipped_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`sport` text NOT NULL,
	`slot_id` text,
	`variant_id` text,
	`counts_in_rotation` integer NOT NULL,
	`gear_id` text,
	`title` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`paused_seconds` integer NOT NULL,
	`local_date` text NOT NULL,
	`time_zone` text NOT NULL,
	`values` text NOT NULL,
	`effort` text,
	`sensation` text,
	`enjoyment` integer,
	`note` text,
	`review` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`slot_id`) REFERENCES `program_slot`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `program_variant`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gear_id`) REFERENCES `gear`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "session_end" CHECK(("session"."status" = 'in_progress') = ("session"."ended_at" IS NULL) AND ("session"."ended_at" IS NULL OR "session"."ended_at" >= "session"."started_at")),
	CONSTRAINT "session_variant" CHECK("session"."variant_id" IS NULL OR "session"."slot_id" IS NOT NULL),
	CONSTRAINT "session_rotation" CHECK(NOT "session"."counts_in_rotation" OR "session"."slot_id" IS NOT NULL),
	CONSTRAINT "session_enjoyment" CHECK("session"."enjoyment" IS NULL OR "session"."enjoyment" BETWEEN 1 AND 5),
	CONSTRAINT "session_paused" CHECK("session"."paused_seconds" >= 0)
);
--> statement-breakpoint
CREATE INDEX `session_date` ON `session` (`local_date`);--> statement-breakpoint
CREATE INDEX `session_sport` ON `session` (`sport`,`started_at`);--> statement-breakpoint
CREATE INDEX `session_slot` ON `session` (`slot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_single_open` ON `session` (1) WHERE "session"."status" <> 'completed' AND "session"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `session_item` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`values` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_item_position` ON `session_item` (`session_id`,`position`);--> statement-breakpoint
CREATE TABLE `strength_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`exercise_id` text NOT NULL,
	`program_item_id` text,
	`status` text NOT NULL,
	`note` text,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercise`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_item_id`) REFERENCES `program_item`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strength_entry_position` ON `strength_entry` (`session_id`,`position`);--> statement-breakpoint
CREATE INDEX `strength_entry_exercise` ON `strength_entry` (`exercise_id`);--> statement-breakpoint
CREATE TABLE `strength_set` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`position` integer NOT NULL,
	`load_grams` integer,
	`reps` integer,
	`duration_seconds` integer,
	`rir` integer,
	`rest_before_seconds` integer,
	`interrupted` integer NOT NULL,
	`completed_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `strength_entry`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "strength_set_rir" CHECK("strength_set"."rir" IS NULL OR "strength_set"."rir" BETWEEN 0 AND 10),
	CONSTRAINT "strength_set_load" CHECK("strength_set"."load_grams" IS NULL OR "strength_set"."load_grams" >= 0),
	CONSTRAINT "strength_set_effort" CHECK("strength_set"."interrupted" OR "strength_set"."reps" > 0 OR "strength_set"."duration_seconds" > 0),
	CONSTRAINT "strength_set_measure" CHECK("strength_set"."reps" IS NULL OR "strength_set"."duration_seconds" IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `strength_set_position` ON `strength_set` (`entry_id`,`position`);--> statement-breakpoint
CREATE TABLE `backup` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`schema_version` integer NOT NULL,
	`catalog_version` integer NOT NULL,
	`includes_photos` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`covered_from` integer,
	`covered_to` integer,
	`snapshot_file` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
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
	`updated_at` integer NOT NULL,
	CONSTRAINT "settings_singleton" CHECK("settings"."singleton" = 1),
	CONSTRAINT "settings_reminder_weekdays" CHECK("settings"."reminder_weekdays" BETWEEN 0 AND 127),
	CONSTRAINT "settings_reminder_minutes" CHECK("settings"."reminder_minutes" BETWEEN 0 AND 1439)
);
--> statement-breakpoint
CREATE TABLE `gear` (
	`id` text PRIMARY KEY NOT NULL,
	`sport` text NOT NULL,
	`name` text NOT NULL,
	`initial_meters` integer NOT NULL,
	`retired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "gear_initial" CHECK("gear"."initial_meters" >= 0)
);
--> statement-breakpoint
CREATE INDEX `gear_sport` ON `gear` (`sport`);--> statement-breakpoint
CREATE TABLE `sport_preference` (
	`sport` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
