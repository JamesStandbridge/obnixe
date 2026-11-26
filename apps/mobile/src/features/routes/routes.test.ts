import { describe, expect, it } from "vitest";
import { commit, importErrorReasons, InvalidRouteError } from "@obnixe/core";
import type { EpochMs, Id } from "@obnixe/schema";
import { coversBounds } from "@/features/maps/offlineRegions";
import type { OfflineRegion } from "@/features/maps/offlineRegions";
import { lastUsedText, routeFigures, startDistanceText } from "@/features/routes/format";
import { candidateFigures, followedRoute, loadRouteGeometry, readRoute, routeById, routeErrorMessage, routeSaveError, writeRouteFile } from "@/features/routes/routeData";
import type { RouteCandidate } from "@/features/routes/routeData";
import { TrackWriteError } from "@/features/tracking/trackStore";
import { db, environment } from "../../../test/mocks/database.ts";
import { storedFiles } from "../../../test/mocks/expoFileSystem.ts";

const encoder = new TextEncoder();
const metersPerDegree = 111_195;

/** A GPX `rte` going north from Grenoble, one point every 100 m, climbing 5 m each. */
function routeGpx(points: number, withAltitude = true): Uint8Array {
  const rtepts = Array.from({ length: points }, (_, index) => {
    const latitude = 45.1885 + (index * 100) / metersPerDegree;
    return `<rtept lat="${latitude.toFixed(7)}" lon="5.7245000">${withAltitude ? `<ele>${200 + index * 5}</ele>` : ""}</rtept>`;
  });
  return encoder.encode(`<?xml version="1.0"?><gpx version="1.1" creator="test"><rte><name>Bastille</name>${rtepts.join("")}</rte></gpx>`);
}

function candidateOf(bytes: Uint8Array): RouteCandidate {
  const reading = readRoute(bytes);
  if (reading.kind !== "read") throw new Error(reading.message);
  return reading.candidate;
}

describe("route files (RTE-001)", () => {
  it("reads a GPX route with the engine's distance and climb", () => {
    const candidate = candidateOf(routeGpx(31));
    expect(candidate.name).toBe("Bastille");
    expect(candidate.sport).toBeNull();
    expect(candidate.elevationSource).toBe("file");
    const figures = candidateFigures(candidate.geometry);
    expect(figures.distanceMm / 1_000_000).toBeCloseTo(3, 1);
    expect(figures.ascentMm).not.toBeNull();
  });

  it("keeps a route without altitude, without D+", () => {
    const candidate = candidateOf(routeGpx(10, false));
    expect(candidate.elevationSource).toBe("none");
    expect(candidateFigures(candidate.geometry).ascentMm).toBeNull();
  });

  it("refuses what is not a route with a message of its own", () => {
    expect(readRoute(encoder.encode("hello"))).toEqual({ kind: "refused", message: routeErrorMessage("unsupported_format") });
    expect(readRoute(routeGpx(1))).toEqual({ kind: "refused", message: routeErrorMessage("not_a_route") });
    for (const reason of importErrorReasons) expect(routeErrorMessage(reason)).not.toBe("");
  });

  it("explains the failures of a save it knows", () => {
    expect(routeSaveError(new InvalidRouteError("name"))).toBe("Donne un nom à l'itinéraire");
    expect(routeSaveError(new TrackWriteError("routes/a.obt"))).toBe("Enregistrement interrompu, rien n'a changé");
    expect(routeSaveError(new Error("other"))).toBeNull();
  });
});

async function saveRoute(candidate: RouteCandidate, name: string): Promise<Id> {
  const plan = await writeRouteFile(candidate, name, "run", null);
  commit(db(), environment, { actor: { author: "user", connectionId: null }, summary: "route", revertsId: null, mutations: [plan.mutation] });
  return plan.routeId;
}

describe("saved routes (RTE-002, RTE-003)", () => {
  it("writes the file before the row and loads it back for the matcher", async () => {
    const routeId = await saveRoute(candidateOf(routeGpx(31)), "  Tour de la Bastille ");
    const row = routeById(routeId);
    expect(row?.name).toBe("Tour de la Bastille");
    expect(row === null ? null : routeFigures(row)).toBe("3,0 km · D+ 150 m");
    if (row === null) throw new Error("route not saved");
    const load = await loadRouteGeometry(row);
    expect(load.kind).toBe("loaded");
    const followed = await followedRoute(routeId);
    expect(followed?.name).toBe("Tour de la Bastille");
    expect(followed?.path.coordinates.length).toBeGreaterThan(1);
    expect(followed?.profile.length).toBeGreaterThan(1);
  });

  it("follows nothing when the file is gone or altered", async () => {
    const routeId = await saveRoute(candidateOf(routeGpx(31)), "Bastille");
    const row = routeById(routeId);
    if (row === null) throw new Error("route not saved");
    expect(await loadRouteGeometry({ ...row, trackSha256: "0".repeat(64) })).toEqual({ kind: "damaged" });
    storedFiles.clear();
    expect(await loadRouteGeometry(row)).toEqual({ kind: "missing" });
    expect(await followedRoute(routeId)).toBeNull();
    expect(await followedRoute("unknown" as Id)).toBeNull();
  });

  it("says the distance to the start and the last use", () => {
    expect(startDistanceText(30)).toBe("au départ");
    expect(startDistanceText(784)).toBe("départ à 780 m");
    expect(startDistanceText(1240)).toBe("départ à 1,2 km");
    expect(startDistanceText(23_600)).toBe("départ à 24 km");
    expect(lastUsedText(null)).toBe("Jamais suivi");
    expect(lastUsedText(Date.UTC(2026, 10, 1, 12) as EpochMs)).toBe("Suivi le 1er novembre");
  });
});

describe("offline route area (RTE-006)", () => {
  const region: OfflineRegion = { id: "a", name: "Grenoble", createdAt: 0 as EpochMs, mapStyle: "obnixe_outdoor", bounds: [5.6, 45.1, 5.9, 45.3], state: "complete", percentage: 100, bytes: 1 };

  it("is covered only by a region of the same base map holding all of it", () => {
    expect(coversBounds([region], [5.7, 45.18, 5.75, 45.22], "obnixe_outdoor")).toBe(true);
    expect(coversBounds([region], [5.7, 45.18, 5.95, 45.22], "obnixe_outdoor")).toBe(false);
    expect(coversBounds([{ ...region, mapStyle: "plan_ign" }], [5.7, 45.18, 5.75, 45.22], "obnixe_outdoor")).toBe(false);
    expect(coversBounds([], [5.7, 45.18, 5.75, 45.22], "obnixe_outdoor")).toBe(false);
  });
});
