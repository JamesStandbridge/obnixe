import { integer, text } from "drizzle-orm/sqlite-core";
import { sportKeys } from "./catalog/sports.ts";
import { zoneKeys } from "./catalog/zones.ts";

export type Id = string & { readonly __brand: "Id" };
export type EpochMs = number & { readonly __brand: "EpochMs" };
export type LocalDate = string & { readonly __brand: "LocalDate" };

export const id = () => text("id").$type<Id>().primaryKey();
export const ref = (name: string) => text(name).$type<Id>();
export const timestamp = (name: string) => integer(name).$type<EpochMs>();
export const localDate = (name: string) => text(name).$type<LocalDate>();
export const sport = (name: string) => text(name, { enum: sportKeys });
export const zone = (name: string) => text(name, { enum: zoneKeys });

export const tracked = () => ({
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const trashable = () => ({
  ...tracked(),
  deletedAt: timestamp("deleted_at"),
});

export const occurred = () => ({
  occurredAt: timestamp("occurred_at").notNull(),
  localDate: localDate("local_date").notNull(),
  timeZone: text("time_zone").notNull(),
});
