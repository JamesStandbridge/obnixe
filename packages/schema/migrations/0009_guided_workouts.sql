ALTER TABLE `program_variant` ADD `workout` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_lap` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`trigger` text NOT NULL,
	`start_offset_ms` integer NOT NULL,
	`end_offset_ms` integer NOT NULL,
	`workout_step` integer,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lap_bounds" CHECK("__new_lap"."start_offset_ms" >= 0 AND "__new_lap"."end_offset_ms" > "__new_lap"."start_offset_ms"),
	CONSTRAINT "lap_workout" CHECK(("__new_lap"."trigger" = 'workout') = ("__new_lap"."workout_step" IS NOT NULL) AND ("__new_lap"."workout_step" IS NULL OR "__new_lap"."workout_step" >= 0))
);
--> statement-breakpoint
INSERT INTO `__new_lap`("id", "session_id", "position", "trigger", "start_offset_ms", "end_offset_ms") SELECT "id", "session_id", "position", "trigger", "start_offset_ms", "end_offset_ms" FROM `lap`;--> statement-breakpoint
DROP TABLE `lap`;--> statement-breakpoint
ALTER TABLE `__new_lap` RENAME TO `lap`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `lap_position` ON `lap` (`session_id`,`position`);--> statement-breakpoint
ALTER TABLE `recording` ADD `workout` text;