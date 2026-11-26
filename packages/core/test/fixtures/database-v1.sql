PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at numeric
			);
INSERT INTO __drizzle_migrations VALUES(NULL,'da4bae9420fae14db8e7add1add3ac70ea7978dc965bf603a3b66326581e0e4e',1793086826331);
INSERT INTO __drizzle_migrations VALUES(NULL,'d3ecdacd0d66731b706d81624757298a0860193f5c7415d5183e28f023512655',1795697653956);
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
INSERT INTO check_in VALUES('01a17da9-2700-700a-9041-8fa025107505',1793109600000,'2026-10-25','Europe/Paris',4,NULL,1793109600000,1793109600000,NULL);
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
CREATE TABLE `measurement_kind` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`zone` text,
	`position` integer NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
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
INSERT INTO photo VALUES('01a17da9-2700-7006-985a-f02ddcf820ae','front',1793109600000,'2026-10-27','Europe/Paris','photos/01a17da9-2700-7006-985a-f02ddcf820ae.jpg','4a1f',4,4,1793109600000,1793109600000,NULL);
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
INSERT INTO weigh_in VALUES('01a17da9-2700-7009-97d5-3dabc2d646ac',1793109600000,'2026-10-24','Europe/Paris',71800,1793109600000,1793109600000,NULL);
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
INSERT INTO exercise VALUES('01a16e36-1300-7000-b324-d734cdb07c26','Développé couché','developpe couche','load_reps','barbell','total',NULL,2500,1,NULL,NULL,NULL,1792850400000,1792850400000);
CREATE TABLE `exercise_zone` (
	`exercise_id` text NOT NULL,
	`zone` text NOT NULL,
	PRIMARY KEY(`exercise_id`, `zone`),
	FOREIGN KEY (`exercise_id`) REFERENCES `exercise`(`id`) ON UPDATE no action ON DELETE cascade
);
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
CREATE TABLE `agent_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`client` text NOT NULL,
	`host` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	CONSTRAINT "agent_connection_end" CHECK(("agent_connection"."ended_at" IS NULL) = ("agent_connection"."end_reason" IS NULL))
);
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
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',0,'sport_preference','strength','insert',NULL,'{"sport":"strength","enabled":true,"position":0,"createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',1,'sport_preference','run','insert',NULL,'{"sport":"run","enabled":true,"position":1,"createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',2,'sport_preference','hike','insert',NULL,'{"sport":"hike","enabled":true,"position":2,"createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',3,'sport_preference','swim','insert',NULL,'{"sport":"swim","enabled":true,"position":3,"createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',4,'sport_preference','bike','insert',NULL,'{"sport":"bike","enabled":true,"position":4,"createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',5,'sport_preference','climb','insert',NULL,'{"sport":"climb","enabled":false,"position":5,"createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',6,'sport_preference','yoga','insert',NULL,'{"sport":"yoga","enabled":false,"position":6,"createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',7,'gear','01a16e36-1300-7007-9943-1eec403a5599','insert',NULL,'{"id":"01a16e36-1300-7007-9943-1eec403a5599","sport":"run","name":"Speedgoat 6","initialMeters":12000,"retiredAt":null,"createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',8,'gear','01a16e36-1300-7008-9c79-85c68272346a','insert',NULL,'{"id":"01a16e36-1300-7008-9c79-85c68272346a","sport":"run","name":"Pegasus 41","initialMeters":0,"retiredAt":null,"createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',9,'gear','01a16e36-1300-7009-931d-67b18143745c','insert',NULL,'{"id":"01a16e36-1300-7009-931d-67b18143745c","sport":"bike","name":"Gravel","initialMeters":0,"retiredAt":null,"createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',10,'exercise','01a16e36-1300-7000-b324-d734cdb07c26','insert',NULL,'{"id":"01a16e36-1300-7000-b324-d734cdb07c26","name":"Développé couché","nameKey":"developpe couche","measure":"load_reps","equipment":"barbell","loadMode":"total","baseGrams":null,"loadStepGrams":2500,"zonesReviewed":true,"cues":null,"mergedIntoId":null,"archivedAt":null,"createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',11,'program','01a16e36-1300-7001-aee9-033ef7136496','insert',NULL,'{"id":"01a16e36-1300-7001-aee9-033ef7136496","status":"active","createdAt":1792850400000,"updatedAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',12,'program_version','01a16e36-1300-7002-81f3-223813bece58','insert',NULL,'{"id":"01a16e36-1300-7002-81f3-223813bece58","programId":"01a16e36-1300-7001-aee9-033ef7136496","number":1,"name":"Prépa trail","sessionsPerWeek":3,"copiedFromId":null,"summary":null,"reason":null,"changesetId":"01a16e36-1300-7011-93e0-bfd4c1dc9f93","createdAt":1792850400000}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',13,'program_slot','01a16e36-1300-7003-b743-180472c3e7a1','insert',NULL,'{"id":"01a16e36-1300-7003-b743-180472c3e7a1","versionId":"01a16e36-1300-7002-81f3-223813bece58","lineageId":"01a16e36-1300-700b-a40d-a0c39209515b","position":0,"sport":"run","name":"Trail long","targetDurationSeconds":7200,"targetEffort":"moderate","targetValues":{"kind":"trail","distance":18000}}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',14,'program_slot','01a16e36-1300-7004-bcce-b7c7a5c3ad80','insert',NULL,'{"id":"01a16e36-1300-7004-bcce-b7c7a5c3ad80","versionId":"01a16e36-1300-7002-81f3-223813bece58","lineageId":"01a16e36-1300-700c-8ca1-487e79351f12","position":1,"sport":"run","name":"Footing","targetDurationSeconds":2700,"targetEffort":"easy","targetValues":{"kind":"easy"}}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',15,'program_slot','01a16e36-1300-7005-90c8-b801985f26bd','insert',NULL,'{"id":"01a16e36-1300-7005-90c8-b801985f26bd","versionId":"01a16e36-1300-7002-81f3-223813bece58","lineageId":"01a16e36-1300-700d-922e-cc2be70adc6b","position":2,"sport":"strength","name":"Haut","targetDurationSeconds":null,"targetEffort":null,"targetValues":{}}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',16,'program_variant','01a16e36-1300-7006-8e8f-c02a0a07841e','insert',NULL,'{"id":"01a16e36-1300-7006-8e8f-c02a0a07841e","slotId":"01a16e36-1300-7005-90c8-b801985f26bd","lineageId":"01a16e36-1300-700e-ac30-30e66d5c8b6f","position":0,"name":"A"}');
INSERT INTO change VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93',17,'program_item','01a16e36-1300-700f-87bf-79ddac3277ca','insert',NULL,'{"id":"01a16e36-1300-700f-87bf-79ddac3277ca","variantId":"01a16e36-1300-7006-8e8f-c02a0a07841e","lineageId":"01a16e36-1300-7010-8ef2-023fd061a5b3","position":0,"exerciseId":"01a16e36-1300-7000-b324-d734cdb07c26","sets":3,"repsMin":6,"repsMax":8,"durationMinSeconds":null,"durationMaxSeconds":null,"targetRir":2,"restSeconds":120,"restAfterSeconds":null}');
INSERT INTO change VALUES('01a1735c-6f00-7002-8d3d-b873677cd526',0,'session','01a1735c-6f00-7000-8980-946e277108dd','insert',NULL,'{"id":"01a1735c-6f00-7000-8980-946e277108dd","sport":"run","slotId":"01a16e36-1300-7003-b743-180472c3e7a1","variantId":null,"countsInRotation":true,"gearId":"01a16e36-1300-7007-9943-1eec403a5599","title":null,"status":"completed","startedAt":1792936800000,"endedAt":1792944300000,"pausedSeconds":300,"localDate":"2026-10-25","timeZone":"Europe/Paris","values":{"kind":"trail","distance":18400,"elevation_gain":1150,"heart_rate_avg":148},"effort":"hard","sensation":null,"enjoyment":null,"note":null,"review":"done","createdAt":1792936800000,"updatedAt":1792936800000,"deletedAt":null}');
INSERT INTO change VALUES('01a1735c-6f00-7002-8d3d-b873677cd526',1,'pain_report','01a1735c-6f00-7001-8c5f-fbe0e15cc6ea','insert',NULL,'{"id":"01a1735c-6f00-7001-8c5f-fbe0e15cc6ea","zone":"knee_left","level":"discomfort","occurredAt":1792936800000,"localDate":"2026-10-25","timeZone":"Europe/Paris","sessionId":"01a1735c-6f00-7000-8980-946e277108dd","phase":"end","strengthSetId":null,"sessionItemId":null,"checkInId":null,"note":null,"createdAt":1792936800000,"updatedAt":1792936800000,"deletedAt":null}');
INSERT INTO change VALUES('01a17882-cb00-7002-8d1a-ebd9d47d21c1',0,'session','01a17882-cb00-7000-9190-589ad973b5ff','insert',NULL,'{"id":"01a17882-cb00-7000-9190-589ad973b5ff","sport":"run","slotId":"01a16e36-1300-7004-bcce-b7c7a5c3ad80","variantId":null,"countsInRotation":true,"gearId":"01a16e36-1300-7008-9c79-85c68272346a","title":null,"status":"completed","startedAt":1793023200000,"endedAt":1793025900000,"pausedSeconds":0,"localDate":"2026-10-26","timeZone":"Europe/Paris","values":{"kind":"easy","distance":8200,"heart_rate_avg":136},"effort":null,"sensation":null,"enjoyment":null,"note":null,"review":"skipped","createdAt":1793023200000,"updatedAt":1793023200000,"deletedAt":null}');
INSERT INTO change VALUES('01a17882-cb00-7002-8d1a-ebd9d47d21c1',1,'session','01a17882-cb00-7001-9f1c-a56c9be75fd2','insert',NULL,'{"id":"01a17882-cb00-7001-9f1c-a56c9be75fd2","sport":"run","slotId":null,"variantId":null,"countsInRotation":false,"gearId":"01a16e36-1300-7007-9943-1eec403a5599","title":null,"status":"completed","startedAt":1793044800000,"endedAt":1793048400000,"pausedSeconds":0,"localDate":"2026-10-26","timeZone":"Europe/Paris","values":{"kind":"trail","distance":9100,"elevation_gain":420},"effort":null,"sensation":null,"enjoyment":null,"note":null,"review":"pending","createdAt":1793023200000,"updatedAt":1793023200000,"deletedAt":null}');
INSERT INTO change VALUES('01a17da9-2700-700b-837a-856cf9422cb7',0,'session','01a17da9-2700-7000-a534-ab20572797bb','insert',NULL,'{"id":"01a17da9-2700-7000-a534-ab20572797bb","sport":"swim","slotId":null,"variantId":null,"countsInRotation":false,"gearId":null,"title":null,"status":"completed","startedAt":1793109600000,"endedAt":1793112000000,"pausedSeconds":0,"localDate":"2026-10-27","timeZone":"Europe/Paris","values":{"kind":"crawl","distance":2000,"pool_length":25,"lengths":80},"effort":null,"sensation":null,"enjoyment":null,"note":null,"review":"skipped","createdAt":1793109600000,"updatedAt":1793109600000,"deletedAt":null}');
INSERT INTO change VALUES('01a17da9-2700-700b-837a-856cf9422cb7',1,'session','01a17da9-2700-7001-bc76-3429c52dcef6','insert',NULL,'{"id":"01a17da9-2700-7001-bc76-3429c52dcef6","sport":"hike","slotId":null,"variantId":null,"countsInRotation":false,"gearId":null,"title":null,"status":"completed","startedAt":1793196000000,"endedAt":1793214000000,"pausedSeconds":2400,"localDate":"2026-10-28","timeZone":"Europe/Paris","values":{"kind":"mountain","distance":15300,"elevation_gain":1240,"pack_mass":6000,"route":"Tour du Taillefer"},"effort":null,"sensation":null,"enjoyment":null,"note":null,"review":"skipped","createdAt":1793109600000,"updatedAt":1793109600000,"deletedAt":null}');
INSERT INTO change VALUES('01a17da9-2700-700b-837a-856cf9422cb7',2,'session','01a17da9-2700-7002-a2cf-25b5cee89a6b','insert',NULL,'{"id":"01a17da9-2700-7002-a2cf-25b5cee89a6b","sport":"bike","slotId":null,"variantId":null,"countsInRotation":false,"gearId":"01a16e36-1300-7009-931d-67b18143745c","title":null,"status":"completed","startedAt":1793282400000,"endedAt":1793291400000,"pausedSeconds":0,"localDate":"2026-10-29","timeZone":"Europe/Paris","values":{"kind":"road","distance":62000,"elevation_gain":780,"power_avg":190},"effort":null,"sensation":null,"enjoyment":null,"note":null,"review":"skipped","createdAt":1793109600000,"updatedAt":1793109600000,"deletedAt":null}');
INSERT INTO change VALUES('01a17da9-2700-700b-837a-856cf9422cb7',3,'session','01a17da9-2700-7003-9531-8666424fead6','insert',NULL,'{"id":"01a17da9-2700-7003-9531-8666424fead6","sport":"strength","slotId":"01a16e36-1300-7005-90c8-b801985f26bd","variantId":"01a16e36-1300-7006-8e8f-c02a0a07841e","countsInRotation":true,"gearId":null,"title":null,"status":"completed","startedAt":1793368800000,"endedAt":1793372400000,"pausedSeconds":0,"localDate":"2026-10-30","timeZone":"Europe/Paris","values":{},"effort":null,"sensation":null,"enjoyment":null,"note":null,"review":"skipped","createdAt":1793109600000,"updatedAt":1793109600000,"deletedAt":null}');
INSERT INTO change VALUES('01a17da9-2700-700b-837a-856cf9422cb7',4,'strength_entry','01a17da9-2700-7004-b6d8-1e8dc9df0e03','insert',NULL,'{"id":"01a17da9-2700-7004-b6d8-1e8dc9df0e03","sessionId":"01a17da9-2700-7003-9531-8666424fead6","position":0,"exerciseId":"01a16e36-1300-7000-b324-d734cdb07c26","programItemId":null,"status":"done","note":null,"plannedSets":null}');
INSERT INTO change VALUES('01a17da9-2700-700b-837a-856cf9422cb7',5,'strength_set','01a17da9-2700-7007-97bd-229e34f53366','insert',NULL,'{"id":"01a17da9-2700-7007-97bd-229e34f53366","entryId":"01a17da9-2700-7004-b6d8-1e8dc9df0e03","position":0,"loadGrams":60000,"reps":8,"durationSeconds":null,"rir":2,"restBeforeSeconds":null,"interrupted":false,"completedAt":1793109600000}');
INSERT INTO change VALUES('01a17da9-2700-700b-837a-856cf9422cb7',6,'strength_set','01a17da9-2700-7008-8de6-c1da562156ce','insert',NULL,'{"id":"01a17da9-2700-7008-8de6-c1da562156ce","entryId":"01a17da9-2700-7004-b6d8-1e8dc9df0e03","position":1,"loadGrams":60000,"reps":7,"durationSeconds":null,"rir":2,"restBeforeSeconds":null,"interrupted":false,"completedAt":1793109600000}');
INSERT INTO change VALUES('01a17da9-2700-700b-837a-856cf9422cb7',7,'session','01a17da9-2700-7005-9275-052087cc83ad','insert',NULL,'{"id":"01a17da9-2700-7005-9275-052087cc83ad","sport":"run","slotId":null,"variantId":null,"countsInRotation":false,"gearId":null,"title":null,"status":"completed","startedAt":1793455200000,"endedAt":1793457000000,"pausedSeconds":0,"localDate":"2026-10-31","timeZone":"Europe/Paris","values":{"kind":"trail","distance":5000},"effort":null,"sensation":null,"enjoyment":null,"note":null,"review":"skipped","createdAt":1793109600000,"updatedAt":1793109600000,"deletedAt":1793109600000}');
INSERT INTO change VALUES('01a17da9-2700-700b-837a-856cf9422cb7',8,'weigh_in','01a17da9-2700-7009-97d5-3dabc2d646ac','insert',NULL,'{"id":"01a17da9-2700-7009-97d5-3dabc2d646ac","occurredAt":1793109600000,"localDate":"2026-10-24","timeZone":"Europe/Paris","grams":71800,"createdAt":1793109600000,"updatedAt":1793109600000,"deletedAt":null}');
INSERT INTO change VALUES('01a17da9-2700-700b-837a-856cf9422cb7',9,'check_in','01a17da9-2700-700a-9041-8fa025107505','insert',NULL,'{"id":"01a17da9-2700-700a-9041-8fa025107505","occurredAt":1793109600000,"localDate":"2026-10-25","timeZone":"Europe/Paris","energy":4,"sleep":null,"createdAt":1793109600000,"updatedAt":1793109600000,"deletedAt":null}');
INSERT INTO change VALUES('01a17da9-2700-700b-837a-856cf9422cb7',10,'photo','01a17da9-2700-7006-985a-f02ddcf820ae','insert',NULL,'{"id":"01a17da9-2700-7006-985a-f02ddcf820ae","pose":"front","occurredAt":1793109600000,"localDate":"2026-10-27","timeZone":"Europe/Paris","file":"photos/01a17da9-2700-7006-985a-f02ddcf820ae.jpg","sha256":"4a1f","width":4,"height":4,"createdAt":1793109600000,"updatedAt":1793109600000,"deletedAt":null}');
CREATE TABLE `changeset` (
	`id` text PRIMARY KEY NOT NULL,
	`author` text NOT NULL,
	`connection_id` text,
	`summary` text NOT NULL,
	`reverts_id` text,
	`companion_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `agent_connection`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`companion_id`) REFERENCES `changeset`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "changeset_agent" CHECK(("changeset"."author" = 'agent') = ("changeset"."connection_id" IS NOT NULL))
);
INSERT INTO changeset VALUES('01a16e36-1300-7011-93e0-bfd4c1dc9f93','user',NULL,'Test',NULL,NULL,1792850400000);
INSERT INTO changeset VALUES('01a1735c-6f00-7002-8d3d-b873677cd526','user',NULL,'Test',NULL,NULL,1792936800000);
INSERT INTO changeset VALUES('01a17882-cb00-7002-8d1a-ebd9d47d21c1','user',NULL,'Test',NULL,NULL,1793023200000);
INSERT INTO changeset VALUES('01a17da9-2700-700b-837a-856cf9422cb7','user',NULL,'Test',NULL,NULL,1793109600000);
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
INSERT INTO pain_report VALUES('01a1735c-6f00-7001-8c5f-fbe0e15cc6ea','knee_left','discomfort',1792936800000,'2026-10-25','Europe/Paris','01a1735c-6f00-7000-8980-946e277108dd','end',NULL,NULL,NULL,NULL,1792936800000,1792936800000,NULL);
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
CREATE TABLE `program` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
INSERT INTO program VALUES('01a16e36-1300-7001-aee9-033ef7136496','active',1792850400000,1792850400000);
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
INSERT INTO program_item VALUES('01a16e36-1300-700f-87bf-79ddac3277ca','01a16e36-1300-7006-8e8f-c02a0a07841e','01a16e36-1300-7010-8ef2-023fd061a5b3',0,'01a16e36-1300-7000-b324-d734cdb07c26',3,6,8,NULL,NULL,2,120,NULL);
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
INSERT INTO program_slot VALUES('01a16e36-1300-7003-b743-180472c3e7a1','01a16e36-1300-7002-81f3-223813bece58','01a16e36-1300-700b-a40d-a0c39209515b',0,'run','Trail long',7200,'moderate','{"kind":"trail","distance":18000}');
INSERT INTO program_slot VALUES('01a16e36-1300-7004-bcce-b7c7a5c3ad80','01a16e36-1300-7002-81f3-223813bece58','01a16e36-1300-700c-8ca1-487e79351f12',1,'run','Footing',2700,'easy','{"kind":"easy"}');
INSERT INTO program_slot VALUES('01a16e36-1300-7005-90c8-b801985f26bd','01a16e36-1300-7002-81f3-223813bece58','01a16e36-1300-700d-922e-cc2be70adc6b',2,'strength','Haut',NULL,NULL,'{}');
CREATE TABLE `program_variant` (
	`id` text PRIMARY KEY NOT NULL,
	`slot_id` text NOT NULL,
	`lineage_id` text NOT NULL,
	`position` integer NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`slot_id`) REFERENCES `program_slot`(`id`) ON UPDATE no action ON DELETE cascade
);
INSERT INTO program_variant VALUES('01a16e36-1300-7006-8e8f-c02a0a07841e','01a16e36-1300-7005-90c8-b801985f26bd','01a16e36-1300-700e-ac30-30e66d5c8b6f',0,'A');
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
INSERT INTO program_version VALUES('01a16e36-1300-7002-81f3-223813bece58','01a16e36-1300-7001-aee9-033ef7136496',1,'Prépa trail',3,NULL,NULL,NULL,'01a16e36-1300-7011-93e0-bfd4c1dc9f93',1792850400000);
CREATE TABLE `rotation_skip` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`slot_lineage_id` text NOT NULL,
	`skipped_at` integer NOT NULL,
	`local_date` text NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `program`(`id`) ON UPDATE no action ON DELETE no action
);
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
INSERT INTO session VALUES('01a1735c-6f00-7000-8980-946e277108dd','run','01a16e36-1300-7003-b743-180472c3e7a1',NULL,1,'01a16e36-1300-7007-9943-1eec403a5599',NULL,'completed',1792936800000,1792944300000,300,'2026-10-25','Europe/Paris','{"kind":"trail","distance":18400,"elevation_gain":1150,"heart_rate_avg":148}','hard',NULL,NULL,NULL,'done',1792936800000,1792936800000,NULL);
INSERT INTO session VALUES('01a17882-cb00-7000-9190-589ad973b5ff','run','01a16e36-1300-7004-bcce-b7c7a5c3ad80',NULL,1,'01a16e36-1300-7008-9c79-85c68272346a',NULL,'completed',1793023200000,1793025900000,0,'2026-10-26','Europe/Paris','{"kind":"easy","distance":8200,"heart_rate_avg":136}',NULL,NULL,NULL,NULL,'skipped',1793023200000,1793023200000,NULL);
INSERT INTO session VALUES('01a17882-cb00-7001-9f1c-a56c9be75fd2','run',NULL,NULL,0,'01a16e36-1300-7007-9943-1eec403a5599',NULL,'completed',1793044800000,1793048400000,0,'2026-10-26','Europe/Paris','{"kind":"trail","distance":9100,"elevation_gain":420}',NULL,NULL,NULL,NULL,'pending',1793023200000,1793023200000,NULL);
INSERT INTO session VALUES('01a17da9-2700-7000-a534-ab20572797bb','swim',NULL,NULL,0,NULL,NULL,'completed',1793109600000,1793112000000,0,'2026-10-27','Europe/Paris','{"kind":"crawl","distance":2000,"pool_length":25,"lengths":80}',NULL,NULL,NULL,NULL,'skipped',1793109600000,1793109600000,NULL);
INSERT INTO session VALUES('01a17da9-2700-7001-bc76-3429c52dcef6','hike',NULL,NULL,0,NULL,NULL,'completed',1793196000000,1793214000000,2400,'2026-10-28','Europe/Paris','{"kind":"mountain","distance":15300,"elevation_gain":1240,"pack_mass":6000,"route":"Tour du Taillefer"}',NULL,NULL,NULL,NULL,'skipped',1793109600000,1793109600000,NULL);
INSERT INTO session VALUES('01a17da9-2700-7002-a2cf-25b5cee89a6b','bike',NULL,NULL,0,'01a16e36-1300-7009-931d-67b18143745c',NULL,'completed',1793282400000,1793291400000,0,'2026-10-29','Europe/Paris','{"kind":"road","distance":62000,"elevation_gain":780,"power_avg":190}',NULL,NULL,NULL,NULL,'skipped',1793109600000,1793109600000,NULL);
INSERT INTO session VALUES('01a17da9-2700-7003-9531-8666424fead6','strength','01a16e36-1300-7005-90c8-b801985f26bd','01a16e36-1300-7006-8e8f-c02a0a07841e',1,NULL,NULL,'completed',1793368800000,1793372400000,0,'2026-10-30','Europe/Paris','{}',NULL,NULL,NULL,NULL,'skipped',1793109600000,1793109600000,NULL);
INSERT INTO session VALUES('01a17da9-2700-7005-9275-052087cc83ad','run',NULL,NULL,0,NULL,NULL,'completed',1793455200000,1793457000000,0,'2026-10-31','Europe/Paris','{"kind":"trail","distance":5000}',NULL,NULL,NULL,NULL,'skipped',1793109600000,1793109600000,1793109600000);
CREATE TABLE `session_item` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`values` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE `strength_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`exercise_id` text NOT NULL,
	`program_item_id` text,
	`status` text NOT NULL,
	`note` text, `planned_sets` integer,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`exercise_id`) REFERENCES `exercise`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_item_id`) REFERENCES `program_item`(`id`) ON UPDATE no action ON DELETE no action
);
INSERT INTO strength_entry VALUES('01a17da9-2700-7004-b6d8-1e8dc9df0e03','01a17da9-2700-7003-9531-8666424fead6',0,'01a16e36-1300-7000-b324-d734cdb07c26',NULL,'done',NULL,NULL);
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
INSERT INTO strength_set VALUES('01a17da9-2700-7007-97bd-229e34f53366','01a17da9-2700-7004-b6d8-1e8dc9df0e03',0,60000,8,NULL,2,NULL,0,1793109600000);
INSERT INTO strength_set VALUES('01a17da9-2700-7008-8de6-c1da562156ce','01a17da9-2700-7004-b6d8-1e8dc9df0e03',1,60000,7,NULL,2,NULL,0,1793109600000);
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
	`rest_alerts_declined_at` integer,
	`rest_alerts_asked_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "settings_singleton" CHECK("settings"."singleton" = 1),
	CONSTRAINT "settings_reminder_weekdays" CHECK("settings"."reminder_weekdays" BETWEEN 0 AND 127),
	CONSTRAINT "settings_reminder_minutes" CHECK("settings"."reminder_minutes" BETWEEN 0 AND 1439)
);
INSERT INTO settings VALUES(1,'dark','kg',0,0,0,0,1110,NULL,NULL,NULL,NULL,NULL,1792850400000);
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
INSERT INTO gear VALUES('01a16e36-1300-7007-9943-1eec403a5599','run','Speedgoat 6',12000,NULL,1792850400000,1792850400000);
INSERT INTO gear VALUES('01a16e36-1300-7008-9c79-85c68272346a','run','Pegasus 41',0,NULL,1792850400000,1792850400000);
INSERT INTO gear VALUES('01a16e36-1300-7009-931d-67b18143745c','bike','Gravel',0,NULL,1792850400000,1792850400000);
CREATE TABLE `sport_preference` (
	`sport` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
INSERT INTO sport_preference VALUES('strength',1,0,1792850400000,1792850400000);
INSERT INTO sport_preference VALUES('run',1,1,1792850400000,1792850400000);
INSERT INTO sport_preference VALUES('hike',1,2,1792850400000,1792850400000);
INSERT INTO sport_preference VALUES('swim',1,3,1792850400000,1792850400000);
INSERT INTO sport_preference VALUES('bike',1,4,1792850400000,1792850400000);
INSERT INTO sport_preference VALUES('climb',0,5,1792850400000,1792850400000);
INSERT INTO sport_preference VALUES('yoga',0,6,1792850400000,1792850400000);
CREATE UNIQUE INDEX `check_in_day` ON `check_in` (`local_date`) WHERE "check_in"."deleted_at" IS NULL;
CREATE UNIQUE INDEX `measurement_day` ON `measurement` (`kind_id`,`local_date`) WHERE "measurement"."deleted_at" IS NULL;
CREATE UNIQUE INDEX `measurement_kind_label` ON `measurement_kind` (lower("label"));
CREATE INDEX `photo_day` ON `photo` (`local_date`);
CREATE UNIQUE INDEX `weigh_in_day` ON `weigh_in` (`local_date`) WHERE "weigh_in"."deleted_at" IS NULL;
CREATE UNIQUE INDEX `exercise_name_key` ON `exercise` (`name_key`) WHERE "exercise"."merged_into_id" IS NULL;
CREATE INDEX `exercise_zone_zone` ON `exercise_zone` (`zone`);
CREATE INDEX `agent_call_connection` ON `agent_call` (`connection_id`,`called_at`);
CREATE INDEX `agent_connection_started` ON `agent_connection` (`started_at`);
CREATE INDEX `change_row` ON `change` (`table_name`,`row_id`);
CREATE INDEX `changeset_created` ON `changeset` (`created_at`);
CREATE UNIQUE INDEX `changeset_reverts` ON `changeset` (`reverts_id`);
CREATE INDEX `pain_report_zone` ON `pain_report` (`zone`,`occurred_at`);
CREATE INDEX `pain_report_session` ON `pain_report` (`session_id`);
CREATE UNIQUE INDEX `pain_report_check_in_zone` ON `pain_report` (`check_in_id`,`zone`) WHERE "pain_report"."check_in_id" IS NOT NULL AND "pain_report"."deleted_at" IS NULL;
CREATE UNIQUE INDEX `zone_tracking_open` ON `zone_tracking` (`zone`) WHERE "zone_tracking"."ended_at" IS NULL;
CREATE UNIQUE INDEX `program_single_active` ON `program` (`status`) WHERE "program"."status" = 'active';
CREATE UNIQUE INDEX `program_item_position` ON `program_item` (`variant_id`,`position`);
CREATE UNIQUE INDEX `program_item_lineage` ON `program_item` (`variant_id`,`lineage_id`);
CREATE INDEX `program_item_exercise` ON `program_item` (`exercise_id`);
CREATE UNIQUE INDEX `program_slot_position` ON `program_slot` (`version_id`,`position`);
CREATE UNIQUE INDEX `program_slot_lineage` ON `program_slot` (`version_id`,`lineage_id`);
CREATE UNIQUE INDEX `program_variant_position` ON `program_variant` (`slot_id`,`position`);
CREATE UNIQUE INDEX `program_variant_lineage` ON `program_variant` (`slot_id`,`lineage_id`);
CREATE UNIQUE INDEX `program_version_number` ON `program_version` (`program_id`,`number`);
CREATE INDEX `rotation_skip_program` ON `rotation_skip` (`program_id`,`skipped_at`);
CREATE INDEX `session_date` ON `session` (`local_date`);
CREATE INDEX `session_sport` ON `session` (`sport`,`started_at`);
CREATE INDEX `session_slot` ON `session` (`slot_id`);
CREATE UNIQUE INDEX `session_single_open` ON `session` (1) WHERE "session"."status" <> 'completed' AND "session"."deleted_at" IS NULL;
CREATE UNIQUE INDEX `session_item_position` ON `session_item` (`session_id`,`position`);
CREATE UNIQUE INDEX `strength_entry_position` ON `strength_entry` (`session_id`,`position`);
CREATE INDEX `strength_entry_exercise` ON `strength_entry` (`exercise_id`);
CREATE UNIQUE INDEX `strength_set_position` ON `strength_set` (`entry_id`,`position`);
CREATE INDEX `gear_sport` ON `gear` (`sport`);
COMMIT;
