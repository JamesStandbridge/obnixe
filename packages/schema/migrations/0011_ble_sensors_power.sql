ALTER TABLE `recording` ADD `cadence_device` text;--> statement-breakpoint
ALTER TABLE `recording` ADD `power_avg` integer;--> statement-breakpoint
ALTER TABLE `recording` ADD `power_device` text;--> statement-breakpoint
UPDATE `sport_preference` SET `recording_settings` = json_set(`recording_settings`, '$.cadenceDevice', NULL, '$.powerDevice', NULL) WHERE `recording_settings` IS NOT NULL;