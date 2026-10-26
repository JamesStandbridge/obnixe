import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { JournaledTable } from "./enums.ts";
import * as tables from "./tables/index.ts";

export const schema = tables;

export const journaled = {
  sport_preference: tables.sportPreference,
  gear: tables.gear,
  exercise: tables.exercise,
  exercise_zone: tables.exerciseZone,
  measurement_kind: tables.measurementKind,
  program: tables.program,
  program_version: tables.programVersion,
  program_slot: tables.programSlot,
  program_variant: tables.programVariant,
  program_item: tables.programItem,
  rotation_skip: tables.rotationSkip,
  session: tables.session,
  strength_entry: tables.strengthEntry,
  strength_set: tables.strengthSet,
  session_item: tables.sessionItem,
  weigh_in: tables.weighIn,
  measurement: tables.measurement,
  photo: tables.photo,
  check_in: tables.checkIn,
  pain_report: tables.painReport,
  zone_tracking: tables.zoneTracking,
} as const satisfies Record<JournaledTable, SQLiteTable>;

export type Exercise = InferSelectModel<typeof tables.exercise>;
export type MeasurementKind = InferSelectModel<typeof tables.measurementKind>;
export type Gear = InferSelectModel<typeof tables.gear>;
export type SportPreference = InferSelectModel<typeof tables.sportPreference>;
export type Program = InferSelectModel<typeof tables.program>;
export type ProgramVersion = InferSelectModel<typeof tables.programVersion>;
export type ProgramSlot = InferSelectModel<typeof tables.programSlot>;
export type ProgramVariant = InferSelectModel<typeof tables.programVariant>;
export type ProgramItem = InferSelectModel<typeof tables.programItem>;
export type RotationSkip = InferSelectModel<typeof tables.rotationSkip>;
export type Session = InferSelectModel<typeof tables.session>;
export type NewSession = InferInsertModel<typeof tables.session>;
export type StrengthEntry = InferSelectModel<typeof tables.strengthEntry>;
export type StrengthSet = InferSelectModel<typeof tables.strengthSet>;
export type SessionItem = InferSelectModel<typeof tables.sessionItem>;
export type WeighIn = InferSelectModel<typeof tables.weighIn>;
export type Measurement = InferSelectModel<typeof tables.measurement>;
export type Photo = InferSelectModel<typeof tables.photo>;
export type CheckIn = InferSelectModel<typeof tables.checkIn>;
export type PainReport = InferSelectModel<typeof tables.painReport>;
export type ZoneTracking = InferSelectModel<typeof tables.zoneTracking>;
export type AgentConnection = InferSelectModel<typeof tables.agentConnection>;
export type AgentCall = InferSelectModel<typeof tables.agentCall>;
export type Changeset = InferSelectModel<typeof tables.changeset>;
export type Change = InferSelectModel<typeof tables.change>;
export type Settings = InferSelectModel<typeof tables.settings>;
export type Backup = InferSelectModel<typeof tables.backup>;
