import { describe, expect, it } from "vitest";
import { commit } from "@obnixe/core";
import type { Mutation } from "@obnixe/core";
import type { EpochMs, FieldValues, Id, LocalDate, SportKey } from "@obnixe/schema";
import { defaultGear } from "@/features/recording/queries";
import { db, environment } from "../../../test/mocks/database.ts";

function write(mutations: readonly Mutation[]): void {
  commit(db(), environment, { actor: { author: "user", connectionId: null }, summary: "Test", revertsId: null, mutations });
}

function newGear(sport: SportKey, name: string): Id {
  const id = environment.newId();
  write([{ kind: "insert", table: "gear", row: { id, sport, name, initialMeters: 0, retiredAt: null } }]);
  return id;
}

function completed(sport: SportKey, values: FieldValues, gearId: Id | null, startedAt: number): void {
  write([
    {
      kind: "insert",
      table: "session",
      row: {
        id: environment.newId(),
        sport,
        slotId: null,
        variantId: null,
        countsInRotation: false,
        gearId,
        title: null,
        status: "completed",
        startedAt: startedAt as EpochMs,
        endedAt: (startedAt + 3_600_000) as EpochMs,
        pausedSeconds: 0,
        localDate: "2026-11-20" as LocalDate,
        timeZone: "Europe/Paris",
        values,
        effort: null,
        sensation: null,
        enjoyment: null,
        note: null,
        review: "skipped",
        deletedAt: null,
      },
    },
  ]);
}

const day = 86_400_000;
const monday = Date.UTC(2026, 10, 16, 7, 0);

describe("defaultGear (INT-010)", () => {
  it("preselects the gear of the latest activity of the same sport and option", () => {
    const road = newGear("bike", "Route");
    const mtb = newGear("bike", "VTT");
    completed("bike", { kind: "road" }, road, monday);
    completed("bike", { kind: "mtb" }, mtb, monday + day);
    expect(defaultGear("bike", "road")).toBe(road);
    expect(defaultGear("bike", "mtb")).toBe(mtb);
    expect(defaultGear("bike", "gravel")).toBe(mtb);
  });

  it("preselects nothing for a retired gear or a sport without gear", () => {
    const shoes = newGear("run", "Pegasus");
    completed("run", {}, shoes, monday);
    expect(defaultGear("run", null)).toBe(shoes);
    write([{ kind: "update", table: "gear", key: shoes, patch: { retiredAt: (monday + day) as EpochMs } }]);
    expect(defaultGear("run", null)).toBeNull();
    expect(defaultGear("swim", null)).toBeNull();
  });
});
