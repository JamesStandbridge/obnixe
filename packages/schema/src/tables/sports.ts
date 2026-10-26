import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, sport, timestamp, tracked } from "../columns.ts";

export const sportPreference = sqliteTable("sport_preference", {
  sport: sport("sport").primaryKey(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  position: integer("position").notNull(),
  ...tracked(),
});

export const gear = sqliteTable(
  "gear",
  {
    id: id(),
    sport: sport("sport").notNull(),
    name: text("name").notNull(),
    initialMeters: integer("initial_meters").notNull(),
    retiredAt: timestamp("retired_at"),
    ...tracked(),
  },
  (t) => [index("gear_sport").on(t.sport), check("gear_initial", sql`${t.initialMeters} >= 0`)],
);
