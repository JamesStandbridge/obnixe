-- Trail gear ids derive from the run gear id with the variant nibble set to 'c', which generated ids never use, so every migrated copy of a database maps a shoe to the same trail gear.
INSERT INTO `gear` (`id`, `sport`, `name`, `initial_meters`, `retired_at`, `created_at`, `updated_at`)
SELECT substr(`id`, 1, 19) || 'c' || substr(`id`, 21), 'trail', `name`, 0, `retired_at`, `created_at`, `updated_at` FROM `gear`
WHERE `sport` = 'run' AND `id` IN (SELECT `gear_id` FROM `session` WHERE `sport` = 'run' AND json_extract(`values`, '$.kind') = 'trail');
--> statement-breakpoint
UPDATE `session` SET `gear_id` = substr(`gear_id`, 1, 19) || 'c' || substr(`gear_id`, 21)
WHERE `sport` = 'run' AND json_extract(`values`, '$.kind') = 'trail' AND `gear_id` IN (SELECT `id` FROM `gear` WHERE `sport` = 'run');
--> statement-breakpoint
UPDATE `session` SET `sport` = 'trail', `values` = json_set(`values`, '$.kind', 'training')
WHERE `sport` = 'run' AND json_extract(`values`, '$.kind') = 'trail';
--> statement-breakpoint
UPDATE `program_slot` SET `sport` = 'trail', `target_values` = json_set(`target_values`, '$.kind', 'training')
WHERE `sport` = 'run' AND json_extract(`target_values`, '$.kind') = 'trail';
--> statement-breakpoint
UPDATE `session` SET `values` = json_set(`values`, '$.water', 'pool') WHERE `sport` = 'swim';
--> statement-breakpoint
INSERT OR IGNORE INTO `sport_preference` (`sport`, `enabled`, `position`, `recording_settings`, `created_at`, `updated_at`)
SELECT 'trail', 1, `position`, NULL, `created_at`, `updated_at` FROM `sport_preference`
WHERE `sport` = 'run'
  AND (EXISTS (SELECT 1 FROM `session` WHERE `sport` = 'trail') OR EXISTS (SELECT 1 FROM `program_slot` WHERE `sport` = 'trail'));
