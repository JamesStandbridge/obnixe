import { beforeEach, describe, expect, it } from "vitest";
import { privacyZone } from "@obnixe/schema";
import type { Id, PrivacyZone } from "@obnixe/schema";
import { planTrashPurge, purgeExpiredTrash, restoreBlocker, restoreMutation, trashItems, trashMutation, trashRetentionMs } from "../data/trash.ts";
import { createTestContext } from "../testing.ts";
import type { TestContext } from "../testing.ts";
import { revert } from "../undo.ts";
import { commit } from "../writer.ts";
import type { Mutation } from "../writer.ts";
import { InvalidPrivacyZoneError, editPrivacyZone, newPrivacyZone, privacyZoneProblem, privacyZoneRadiusBounds } from "./privacyZones.ts";
import type { PrivacyZoneDraft } from "./privacyZones.ts";

let context: TestContext;

beforeEach(() => {
  context = createTestContext();
});

function write(mutations: readonly Mutation[]): Id {
  return commit(context.db, context.env, { actor: { author: "user", connectionId: null }, summary: "Test", revertsId: null, mutations });
}

const home: PrivacyZoneDraft = { label: "  Maison ", center: { latitude: 45.9237012345, longitude: 6.8694987654 }, radiusMeters: 300 };

function created(draft: PrivacyZoneDraft = home, maskScalePermille = 1170): PrivacyZone {
  const plan = newPrivacyZone(context.env, draft, maskScalePermille);
  write([plan.mutation]);
  const row = context.db.select().from(privacyZone).get();
  if (row === undefined || row.id !== plan.zoneId) throw new Error("missing zone");
  return row;
}

describe("privacy zone plans", () => {
  it("stores a new zone with a trimmed label, its center in 1e-7 degrees and its mask draw (PRV-010, PRV-012)", () => {
    expect(created()).toMatchObject({ label: "Maison", latitudeE7: 459237012, longitudeE7: 68694988, radiusMeters: 300, maskScalePermille: 1170, deletedAt: null });
  });

  it("refuses an empty label, a radius outside 100 to 2000 m and an impossible center", () => {
    expect(privacyZoneProblem(home)).toBeNull();
    expect(privacyZoneProblem({ ...home, label: " " })).toBe("label");
    expect(privacyZoneProblem({ ...home, radiusMeters: privacyZoneRadiusBounds.minMeters - 1 })).toBe("radius");
    expect(privacyZoneProblem({ ...home, radiusMeters: privacyZoneRadiusBounds.maxMeters + 1 })).toBe("radius");
    expect(privacyZoneProblem({ ...home, radiusMeters: 250.5 })).toBe("radius");
    expect(privacyZoneProblem({ ...home, center: { latitude: 91, longitude: 0 } })).toBe("position");
    expect(privacyZoneProblem({ ...home, center: { latitude: Number.NaN, longitude: 0 } })).toBe("position");
    expect(() => newPrivacyZone(context.env, { ...home, label: "" }, 1000)).toThrow(InvalidPrivacyZoneError);
    expect(privacyZoneProblem({ ...home, radiusMeters: 100 })).toBeNull();
    expect(privacyZoneProblem({ ...home, radiusMeters: 2000 })).toBeNull();
  });

  it("edits only the changed fields and keeps the mask draw", () => {
    const zone = created();
    expect(editPrivacyZone(zone, home)).toBeNull();
    const edit = editPrivacyZone(zone, { ...home, label: "Maison", center: { latitude: 45.93, longitude: 6.8694987654 }, radiusMeters: 500 });
    expect(edit).toEqual({ kind: "update", table: "privacy_zone", key: zone.id, patch: { latitudeE7: 459300000, radiusMeters: 500 } });
    if (edit === null) throw new Error("missing edit");
    write([edit]);
    expect(context.db.select().from(privacyZone).get()).toMatchObject({ latitudeE7: 459300000, longitudeE7: 68694988, radiusMeters: 500, maskScalePermille: 1170 });
  });

  it("puts a deleted zone in the trash, restores it, and purges it after 30 days", () => {
    const zone = created();
    const trashed = write([trashMutation("privacy_zone", zone.id, context.env.now())]);
    const [item] = trashItems(context.db);
    expect(item).toMatchObject({ table: "privacy_zone", row: { id: zone.id, label: "Maison" }, expiresAt: context.env.now() + trashRetentionMs });
    if (item === undefined) throw new Error("missing trash item");
    expect(restoreBlocker(context.db, item)).toBeNull();
    revert(context.db, context.env, { actor: { author: "user", connectionId: null }, changesetId: trashed, summary: "Annulation", restoredVersionSummary: () => "" });
    expect(context.db.select({ deletedAt: privacyZone.deletedAt }).from(privacyZone).get()).toEqual({ deletedAt: null });

    write([trashMutation("privacy_zone", zone.id, context.env.now())]);
    write([restoreMutation(item)]);
    expect(trashItems(context.db)).toHaveLength(0);

    write([trashMutation("privacy_zone", zone.id, context.env.now())]);
    context.advance(trashRetentionMs - 1);
    expect(planTrashPurge(context.db, context.env.now()).deletions).toHaveLength(0);
    context.advance(2);
    expect(purgeExpiredTrash(context.db, context.env).purgedRows).toBe(1);
    expect(context.db.select().from(privacyZone).all()).toHaveLength(0);
  });
});
