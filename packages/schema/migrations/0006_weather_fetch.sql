CREATE TABLE `weather_fetch` (
	`session_id` text PRIMARY KEY NOT NULL,
	`failed_attempts` integer NOT NULL,
	`retry_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "weather_fetch_attempts" CHECK("weather_fetch"."failed_attempts" >= 1)
);
