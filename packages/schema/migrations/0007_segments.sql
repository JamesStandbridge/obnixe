CREATE TABLE `segment_derivation` (
	`segment_id` text PRIMARY KEY NOT NULL,
	`shape_key` text NOT NULL,
	FOREIGN KEY (`segment_id`) REFERENCES `segment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_segment` (
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
	FOREIGN KEY (`source_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "segment_distance" CHECK("__new_segment"."distance_mm" >= 100000)
);
--> statement-breakpoint
INSERT INTO `__new_segment`("id", "name", "family", "polyline", "distance_mm", "ascent_mm", "bbox", "south", "north", "source_session_id", "created_at", "updated_at", "deleted_at") SELECT "id", "name", "family", "polyline", "distance_mm", "ascent_mm", "bbox", "south", "north", "source_session_id", "created_at", "updated_at", "deleted_at" FROM `segment`;--> statement-breakpoint
DROP TABLE `segment`;--> statement-breakpoint
ALTER TABLE `__new_segment` RENAME TO `segment`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `segment_bbox` ON `segment` (`family`,`south`,`north`);