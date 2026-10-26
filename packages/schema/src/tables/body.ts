import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { id, occurred, ref, timestamp, tracked, trashable, zone } from "../columns.ts";
import { photoPoses, sleepBuckets } from "../enums.ts";

export const measurementKind = sqliteTable(
  "measurement_kind",
  {
    id: id(),
    label: text("label").notNull(),
    zone: zone("zone"),
    position: integer("position").notNull(),
    archivedAt: timestamp("archived_at"),
    ...tracked(),
  },
  (t) => [uniqueIndex("measurement_kind_label").on(sql`lower(${t.label})`)],
);

export const weighIn = sqliteTable(
  "weigh_in",
  {
    id: id(),
    ...occurred(),
    grams: integer("grams").notNull(),
    ...trashable(),
  },
  (t) => [
    uniqueIndex("weigh_in_day").on(t.localDate).where(sql`${t.deletedAt} IS NULL`),
    check("weigh_in_grams", sql`${t.grams} BETWEEN 20000 AND 400000`),
  ],
);

export const measurement = sqliteTable(
  "measurement",
  {
    id: id(),
    kindId: ref("kind_id").notNull().references(() => measurementKind.id),
    ...occurred(),
    millimeters: integer("millimeters").notNull(),
    ...trashable(),
  },
  (t) => [
    uniqueIndex("measurement_day").on(t.kindId, t.localDate).where(sql`${t.deletedAt} IS NULL`),
    check("measurement_positive", sql`${t.millimeters} > 0`),
  ],
);

export const photo = sqliteTable(
  "photo",
  {
    id: id(),
    pose: text("pose", { enum: photoPoses }).notNull(),
    ...occurred(),
    file: text("file").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    ...trashable(),
  },
  (t) => [index("photo_day").on(t.localDate)],
);

export const checkIn = sqliteTable(
  "check_in",
  {
    id: id(),
    ...occurred(),
    energy: integer("energy"),
    sleep: text("sleep", { enum: sleepBuckets }),
    ...trashable(),
  },
  (t) => [
    uniqueIndex("check_in_day").on(t.localDate).where(sql`${t.deletedAt} IS NULL`),
    check("check_in_energy", sql`${t.energy} IS NULL OR ${t.energy} BETWEEN 1 AND 5`),
  ],
);
