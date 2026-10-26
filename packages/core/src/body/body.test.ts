import { isNull } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { measurement, measurementKind, weighIn } from "@obnixe/schema";
import type { EpochMs, Id, LocalDate, Photo } from "@obnixe/schema";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { revert } from "../undo.ts";
import { commit } from "../writer.ts";
import type { Mutation } from "../writer.ts";
import { DuplicateKindError, EmptyKindLabelError, InvalidMeasurementError, measurementsOverview, planKindArchive, planMeasurement, planMeasurementKind } from "./measurements.ts";
import { nextPose, photoOverview, photosOfPose, planPhoto } from "./photos.ts";
import { WeightOutOfRangeError, gramsToMass, massToGrams, planTrash, planWeighIn, weighInOn, weightTrend } from "./weight.ts";
import type { WeightPoint } from "./weight.ts";

const zone = "Europe/Paris";
const day = 86_400_000;
let context: TestContext;

beforeEach(() => {
  context = createTestContext();
});

function write(mutations: readonly Mutation[]): Id {
  return commit(context.db, context.env, { actor: { author: "user", connectionId: null }, summary: "Test", revertsId: null, mutations });
}

function weigh(grams: number): Id {
  const plan = planWeighIn(context.db, context.env, { grams, occurredAt: context.env.now(), timeZone: zone });
  write([plan.mutation]);
  return plan.weighInId;
}

describe("weigh-ins", () => {
  it("converts between grams and the display unit", () => {
    expect(gramsToMass(74_800, "kg")).toBe(74.8);
    expect(massToGrams(74.8, "kg")).toBe(74_800);
    expect(gramsToMass(74_800, "lb")).toBe(164.9);
    expect(massToGrams(164.9, "lb")).toBe(74_797);
  });

  it("keeps one weigh-in per day, replacing it on a second save", () => {
    const first = weigh(74_800);
    context.advance(3_600_000);
    const plan = planWeighIn(context.db, context.env, { grams: 74_900, occurredAt: context.env.now(), timeZone: zone });
    expect(plan.weighInId).toBe(first);
    expect(plan.replaced?.grams).toBe(74_800);
    write([plan.mutation]);
    expect(context.db.select().from(weighIn).all().map((row) => row.grams)).toEqual([74_900]);
  });

  it("trashes a weigh-in, allows a new one that day, and restores on undo", () => {
    const first = weigh(74_800);
    const trashed = write([planTrash(context.env, "weigh_in", first)]);
    expect(weighInOn(context.db, "2026-10-24" as LocalDate)).toBeNull();
    weigh(75_000);
    expect(context.db.select().from(weighIn).where(isNull(weighIn.deletedAt)).all()).toHaveLength(1);
    expect(() => revert(context.db, context.env, { actor: { author: "user", connectionId: null }, changesetId: trashed, summary: "Annulation", restoredVersionSummary: () => "" })).toThrow(/UNIQUE/);
  });

  it("refuses implausible weights", () => {
    expect(() => planWeighIn(context.db, context.env, { grams: 9_000, occurredAt: context.env.now(), timeZone: zone })).toThrow(WeightOutOfRangeError);
  });

  it("summarises the last seven days and the 30-day trend", () => {
    const point = (date: string, grams: number): WeightPoint => ({ localDate: date as LocalDate, grams });
    const trend = weightTrend(
      [point("2026-09-20", 75_600), point("2026-09-22", 75_400), point("2026-10-19", 74_900), point("2026-10-20", 75_100), point("2026-10-22", 74_700), point("2026-10-23", 74_800)],
      "2026-10-25" as LocalDate,
    );
    expect(trend.latest).toEqual(point("2026-10-23", 74_800));
    expect(trend.today).toBeNull();
    expect(trend.average7).toBe(74_875);
    expect(trend.delta30).toBe(74_875 - 75_500);
    expect(trend.days.map((entry) => entry.grams)).toEqual([74_900, 75_100, null, 74_700, 74_800, null, null]);
    expect(trend.days.at(-1)?.localDate).toBe("2026-10-25");
    expect(weightTrend([], "2026-10-25" as LocalDate)).toMatchObject({ latest: null, average7: null, delta30: null });
  });
});

describe("measurements", () => {
  it("creates user kinds with unique labels and revives archived ones", () => {
    const waist = planMeasurementKind(context.db, context.env, "  Tour  de taille ");
    write([waist.mutation]);
    expect(context.db.select().from(measurementKind).get()).toMatchObject({ label: "Tour de taille", position: 0 });
    expect(() => planMeasurementKind(context.db, context.env, "tour de TAILLE")).toThrow(DuplicateKindError);
    expect(() => planMeasurementKind(context.db, context.env, " ")).toThrow(EmptyKindLabelError);
    const hips = planMeasurementKind(context.db, context.env, "Hanches");
    write([hips.mutation]);
    expect(context.db.select().from(measurementKind).all().map((kind) => kind.position)).toEqual([0, 1]);
    write([planKindArchive(context.env, waist.kindId)]);
    const revived = planMeasurementKind(context.db, context.env, "Tour de taille");
    expect(revived.kindId).toBe(waist.kindId);
    write([revived.mutation]);
    expect(context.db.select().from(measurementKind).all().every((kind) => kind.archivedAt === null)).toBe(true);
  });

  it("keeps one value per kind and day and reports deltas", () => {
    const waist = planMeasurementKind(context.db, context.env, "Tour de taille");
    const hips = planMeasurementKind(context.db, context.env, "Hanches");
    write([waist.mutation, hips.mutation]);
    const measure = (kindId: Id, millimeters: number): void => {
      write([planMeasurement(context.db, context.env, { kindId, millimeters, occurredAt: context.env.now(), timeZone: zone }).mutation]);
    };
    measure(waist.kindId, 830);
    measure(hips.kindId, 960);
    context.advance(12 * day);
    measure(waist.kindId, 825);
    measure(waist.kindId, 820);
    measure(hips.kindId, 960);
    expect(() => planMeasurement(context.db, context.env, { kindId: waist.kindId, millimeters: 0, occurredAt: context.env.now(), timeZone: zone })).toThrow(InvalidMeasurementError);
    const kinds = context.db.select().from(measurementKind).all();
    const overview = measurementsOverview(kinds, context.db.select().from(measurement).all());
    expect(overview.latestDate).toBe("2026-11-05");
    expect(overview.kinds.map((summary) => [summary.kind.label, summary.latest?.millimeters, summary.delta])).toEqual([
      ["Tour de taille", 820, -10],
      ["Hanches", 960, 0],
    ]);
  });
});

describe("photos", () => {
  const photo = (id: string, pose: "front" | "side" | "back", at: number, deleted = false): Photo => {
    const row = planPhoto({ id: id as Id, pose, occurredAt: at as EpochMs, timeZone: zone, file: `photos/${id}.jpg`, sha256: "ab", width: 900, height: 1200 });
    if (row.kind !== "insert" || row.table !== "photo") throw new Error("unexpected mutation");
    return { ...row.row, createdAt: at as EpochMs, updatedAt: at as EpochMs, deletedAt: deleted ? (at as EpochMs) : null };
  };

  it("stores photos with their local day", () => {
    const mutation = planPhoto({ id: context.env.newId(), pose: "front", occurredAt: context.env.now(), timeZone: zone, file: "photos/a.jpg", sha256: "ff", width: 3, height: 4 });
    write([mutation]);
    expect(mutation.kind === "insert" && mutation.table === "photo" ? mutation.row.localDate : null).toBe("2026-10-24");
  });

  it("shows the newest live photo of each pose", () => {
    const at = Date.UTC(2026, 9, 12, 9);
    const photos = [photo("a", "front", at), photo("b", "side", at), photo("c", "front", at + day), photo("d", "back", at + 2 * day, true)];
    const overview = photoOverview(photos);
    expect(overview.latestDate).toBe("2026-10-13");
    expect(overview.slots.map((slot) => [slot.pose, slot.photo?.id ?? null])).toEqual([["front", "c"], ["side", "b"], ["back", null]]);
    expect(photosOfPose(photos, "front").map((item) => item.id)).toEqual(["c", "a"]);
    expect(nextPose(photos, "2026-10-12" as LocalDate)).toBe("back");
    expect(nextPose([], "2026-10-12" as LocalDate)).toBe("front");
  });
});
