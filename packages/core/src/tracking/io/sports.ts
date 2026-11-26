import type { FieldValues, SportKey } from "@obnixe/schema";

/** Sport and variant detected in a file (annex D), offered to the user before the import (`IO-010`). */
export interface SportGuess {
  readonly sport: SportKey;
  readonly values: FieldValues;
}

const guess = (sport: SportKey, values: FieldValues = {}): SportGuess => ({ sport, values });

/** FIT `sport` and `sub_sport` values of the profile. */
export const fitSport = { generic: 0, running: 1, cycling: 2, swimming: 5, walking: 11, hiking: 17, eBiking: 21, snowshoeing: 35 } as const;
export const fitSubSport = {
  generic: 0,
  treadmill: 1,
  street: 2,
  trail: 3,
  spin: 5,
  indoorCycling: 6,
  road: 7,
  mountain: 8,
  downhill: 9,
  cyclocross: 11,
  lapSwimming: 17,
  openWater: 18,
  gravelCycling: 46,
  eBikeMountain: 47,
  commuting: 48,
  virtualActivity: 58,
  enduro: 123,
} as const;

function cyclingKind(subSport: number | null): string {
  switch (subSport) {
    case fitSubSport.gravelCycling:
    case fitSubSport.cyclocross:
      return "gravel";
    case fitSubSport.mountain:
    case fitSubSport.downhill:
    case fitSubSport.enduro:
      return "mtb";
    case fitSubSport.commuting:
      return "commute";
    case fitSubSport.spin:
    case fitSubSport.indoorCycling:
    case fitSubSport.virtualActivity:
      return "indoor";
    default:
      return "road";
  }
}

/** Annex D, FIT column; a swim without a sub sport is a pool swim unless it has positions. */
export function sportOfFit(sport: number, subSport: number | null, positioned: boolean): SportGuess | null {
  switch (sport) {
    case fitSport.running:
      return guess(subSport === fitSubSport.trail ? "trail" : "run");
    case fitSport.walking:
      return guess("walk");
    case fitSport.hiking:
      return guess("hike");
    case fitSport.snowshoeing:
      return guess("hike", { kind: "snow" });
    case fitSport.cycling:
      return guess("bike", { kind: cyclingKind(subSport) });
    case fitSport.eBiking:
      return guess("bike", { kind: subSport === fitSubSport.eBikeMountain ? "mtb" : "road", e_bike: true });
    case fitSport.swimming: {
      const openWater = subSport === fitSubSport.openWater || (subSport !== fitSubSport.lapSwimming && positioned);
      return guess("swim", { water: openWater ? "open_water" : "pool" });
    }
    default:
      return null;
  }
}

const gpxTypes: Readonly<Record<string, SportGuess>> = {
  run: guess("run"),
  running: guess("run"),
  road_running: guess("run"),
  street_running: guess("run"),
  track_running: guess("run"),
  trail: guess("trail"),
  trail_running: guess("trail"),
  walk: guess("walk"),
  walking: guess("walk"),
  casual_walking: guess("walk"),
  speed_walking: guess("walk"),
  hike: guess("hike"),
  hiking: guess("hike"),
  snowshoe: guess("hike", { kind: "snow" }),
  snowshoeing: guess("hike", { kind: "snow" }),
  bike: guess("bike", { kind: "road" }),
  biking: guess("bike", { kind: "road" }),
  cycling: guess("bike", { kind: "road" }),
  ride: guess("bike", { kind: "road" }),
  road_biking: guess("bike", { kind: "road" }),
  road_cycling: guess("bike", { kind: "road" }),
  gravel: guess("bike", { kind: "gravel" }),
  gravel_cycling: guess("bike", { kind: "gravel" }),
  gravel_ride: guess("bike", { kind: "gravel" }),
  mtb: guess("bike", { kind: "mtb" }),
  mountain_biking: guess("bike", { kind: "mtb" }),
  mountain_bike_ride: guess("bike", { kind: "mtb" }),
  e_bike: guess("bike", { kind: "road", e_bike: true }),
  e_biking: guess("bike", { kind: "road", e_bike: true }),
  e_bike_ride: guess("bike", { kind: "road", e_bike: true }),
  swim: guess("swim", { water: "open_water" }),
  swimming: guess("swim", { water: "open_water" }),
  open_water_swimming: guess("swim", { water: "open_water" }),
};

/** Annex D, GPX column, with the `type` values written by Garmin Connect, Strava and Komoot. */
export function sportOfGpxType(type: string): SportGuess | null {
  const key = type
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return gpxTypes[key] ?? null;
}

export interface FitSportPair {
  readonly sport: number;
  readonly subSport: number;
}

const fitPair = (sport: number, subSport: number): FitSportPair => ({ sport, subSport });

function fitCycling(values: FieldValues): FitSportPair {
  const kind = values.kind;
  if (values.e_bike === true) return fitPair(fitSport.eBiking, kind === "mtb" ? fitSubSport.eBikeMountain : fitSubSport.generic);
  switch (kind) {
    case "gravel":
      return fitPair(fitSport.cycling, fitSubSport.gravelCycling);
    case "mtb":
      return fitPair(fitSport.cycling, fitSubSport.mountain);
    case "commute":
      return fitPair(fitSport.cycling, fitSubSport.commuting);
    case "indoor":
      return fitPair(fitSport.cycling, fitSubSport.virtualActivity);
    default:
      return fitPair(fitSport.cycling, fitSubSport.road);
  }
}

/** Annex D, FIT column, for the export (`IO-003`): a sport without a FIT counterpart is `generic`. */
export function fitSportOf(sport: SportKey, values: FieldValues): FitSportPair {
  switch (sport) {
    case "run":
      return fitPair(fitSport.running, fitSubSport.street);
    case "trail":
      return fitPair(fitSport.running, fitSubSport.trail);
    case "walk":
      return fitPair(fitSport.walking, fitSubSport.generic);
    case "hike":
      return fitPair(fitSport.hiking, fitSubSport.generic);
    case "bike":
      return fitCycling(values);
    case "swim":
      return fitPair(fitSport.swimming, values.water === "pool" ? fitSubSport.lapSwimming : fitSubSport.openWater);
    case "strength":
    case "climb":
    case "yoga":
      return fitPair(fitSport.generic, fitSubSport.generic);
    default: {
      const unhandled: never = sport;
      throw new Error(`No FIT sport for ${String(unhandled)}`);
    }
  }
}

export type TcxSport = "Running" | "Biking" | "Other";

/** TCX knows running and biking only; everything else is `Other`. */
export function tcxSportOf(sport: SportKey): TcxSport {
  switch (sport) {
    case "run":
    case "trail":
      return "Running";
    case "bike":
      return "Biking";
    case "walk":
    case "hike":
    case "swim":
    case "strength":
    case "climb":
    case "yoga":
      return "Other";
    default: {
      const unhandled: never = sport;
      throw new Error(`No TCX sport for ${String(unhandled)}`);
    }
  }
}

/** TCX `Activity/@Sport`: `Running`, `Biking` or `Other`. */
export function sportOfTcx(sport: string): SportGuess | null {
  switch (sport) {
    case "Running":
      return guess("run");
    case "Biking":
      return guess("bike", { kind: "road" });
    default:
      return null;
  }
}
