import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { painReport, program, programItem, programSlot, programVariant, programVersion } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, PainLevel, ZoneKey } from "@obnixe/schema";
import type { ObnixeDatabase } from "../database.ts";
import { localDateOf } from "../dates.ts";
import { isPainful } from "../training/pain.ts";
import { exerciseIdsWithMerged } from "./exercise.ts";

export interface PainSample {
  readonly zone: ZoneKey;
  readonly level: PainLevel;
  readonly occurredAt: EpochMs;
  readonly localDate: LocalDate;
}

/** `to` is null while the period is still running. */
export interface SuspensionPeriod {
  readonly from: LocalDate;
  readonly to: LocalDate | null;
  readonly zones: readonly ZoneKey[];
}

interface OpenPeriod {
  readonly from: LocalDate;
  readonly zones: Set<ZoneKey>;
}

/** Mirrors the progression rule: an exercise stops progressing while the latest report on any zone it loads is painful. */
export function suspensionPeriods(samples: readonly PainSample[], zones: readonly ZoneKey[]): SuspensionPeriod[] {
  const loaded = new Set(zones);
  const latest = new Map<ZoneKey, PainLevel>();
  const periods: SuspensionPeriod[] = [];
  let open: OpenPeriod | null = null;
  const ordered = samples.filter((sample) => loaded.has(sample.zone)).sort((left, right) => left.occurredAt - right.occurredAt);
  for (const sample of ordered) {
    latest.set(sample.zone, sample.level);
    const painful = [...latest].filter(([, level]) => isPainful(level)).map(([zone]) => zone);
    if (painful.length > 0) {
      if (open === null) {
        const previous = periods.at(-1);
        if (previous !== undefined && previous.to === sample.localDate) {
          periods.pop();
          open = { from: previous.from, zones: new Set(previous.zones) };
        } else {
          open = { from: sample.localDate, zones: new Set() };
        }
      }
      for (const zone of painful) open.zones.add(zone);
    } else if (open !== null) {
      periods.push({ from: open.from, to: sample.localDate, zones: [...open.zones] });
      open = null;
    }
  }
  if (open !== null) periods.push({ from: open.from, to: null, zones: [...open.zones] });
  return periods;
}

export function painSamples(db: ObnixeDatabase, zones: readonly ZoneKey[]): PainSample[] {
  if (zones.length === 0) return [];
  return db
    .select({ zone: painReport.zone, level: painReport.level, occurredAt: painReport.occurredAt, localDate: painReport.localDate })
    .from(painReport)
    .where(and(inArray(painReport.zone, [...zones]), isNull(painReport.deletedAt)))
    .orderBy(asc(painReport.occurredAt))
    .all();
}

export interface VersionSample {
  readonly programId: Id;
  readonly number: number;
  readonly name: string;
  readonly createdAt: EpochMs;
  readonly exerciseIds: ReadonlySet<Id>;
}

export interface VersionMarker {
  readonly localDate: LocalDate;
  readonly programId: Id;
  readonly number: number;
  readonly name: string;
}

/** A version matters to an exercise when it or the version it replaced prescribes the exercise; several versions on one day collapse to the last one. */
export function versionMarkers(versions: readonly VersionSample[], exerciseIds: ReadonlySet<Id>, timeZone: string): VersionMarker[] {
  const prescribes = (version: VersionSample | undefined): boolean => version !== undefined && [...version.exerciseIds].some((id) => exerciseIds.has(id));
  const byProgram = new Map<Id, VersionSample[]>();
  for (const version of versions) byProgram.set(version.programId, [...(byProgram.get(version.programId) ?? []), version]);
  const relevant: VersionSample[] = [];
  for (const list of byProgram.values()) {
    const ordered = [...list].sort((left, right) => left.number - right.number);
    ordered.forEach((version, index) => {
      if (prescribes(version) || prescribes(ordered[index - 1])) relevant.push(version);
    });
  }
  const byDate = new Map<LocalDate, VersionMarker>();
  for (const version of relevant.sort((left, right) => left.createdAt - right.createdAt)) {
    const localDate = localDateOf(version.createdAt, timeZone);
    byDate.set(localDate, { localDate, programId: version.programId, number: version.number, name: version.name });
  }
  return [...byDate.values()];
}

/** Draft programs were never followed, so their versions are left out. */
export function exerciseVersionMarkers(db: ObnixeDatabase, exerciseId: Id, timeZone: string): VersionMarker[] {
  const versions = db
    .select({ id: programVersion.id, programId: programVersion.programId, number: programVersion.number, name: programVersion.name, createdAt: programVersion.createdAt })
    .from(programVersion)
    .innerJoin(program, eq(programVersion.programId, program.id))
    .where(ne(program.status, "draft"))
    .all();
  if (versions.length === 0) return [];
  const items = db
    .select({ versionId: programSlot.versionId, exerciseId: programItem.exerciseId })
    .from(programItem)
    .innerJoin(programVariant, eq(programItem.variantId, programVariant.id))
    .innerJoin(programSlot, eq(programVariant.slotId, programSlot.id))
    .where(inArray(programSlot.versionId, versions.map((version) => version.id)))
    .all();
  const samples = versions.map((version): VersionSample => ({ ...version, exerciseIds: new Set(items.filter((item) => item.versionId === version.id).map((item) => item.exerciseId)) }));
  return versionMarkers(samples, new Set(exerciseIdsWithMerged(db, exerciseId)), timeZone);
}
