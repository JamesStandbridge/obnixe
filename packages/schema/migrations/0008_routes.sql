CREATE TABLE `route` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sport` text NOT NULL,
	`distance_mm` integer NOT NULL,
	`ascent_mm` integer,
	`descent_mm` integer,
	`elevation_source` text NOT NULL,
	`reversed` integer NOT NULL,
	`bbox` text NOT NULL,
	`preview_polyline` text NOT NULL,
	`track_file` text NOT NULL,
	`track_sha256` text NOT NULL,
	`track_bytes` integer NOT NULL,
	`point_count` integer NOT NULL,
	`source_session_id` text,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`source_session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "route_distance" CHECK("route"."distance_mm" > 0 AND "route"."point_count" >= 2),
	CONSTRAINT "route_elevation" CHECK(("route"."ascent_mm" IS NULL) = ("route"."elevation_source" = 'none') AND ("route"."ascent_mm" IS NULL) = ("route"."descent_mm" IS NULL) AND ("route"."ascent_mm" IS NULL OR ("route"."ascent_mm" >= 0 AND "route"."descent_mm" >= 0)))
);
--> statement-breakpoint
ALTER TABLE `recording` ADD `route_id` text REFERENCES `route`(`id`) ON UPDATE no action ON DELETE set null;