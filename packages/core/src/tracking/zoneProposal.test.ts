import { describe, expect, it } from "vitest";
import { displace, ellipsoidDistance } from "./geo.ts";
import type { GeoPoint } from "./geo.ts";
import type { MaskZone } from "./privacy.ts";
import { origin } from "./testing/fixes.ts";
import { proposeZone, zoneProposalRules } from "./zoneProposal.ts";
import type { ActivityEnds } from "./zoneProposal.ts";

function at(east: number, north: number): GeoPoint {
  return displace(origin.latitude, origin.longitude, east, north);
}

/** An activity between two points given as east-north offsets from `origin`. */
function activity(from: readonly [number, number], to: readonly [number, number]): ActivityEnds {
  return { start: at(from[0], from[1]), end: at(to[0], to[1]) };
}

function zoneAt(east: number, north: number, radiusMeters: number): MaskZone {
  const center = at(east, north);
  return { latitudeE7: Math.round(center.latitude * 1e7), longitudeE7: Math.round(center.longitude * 1e7), radiusMeters, maskScalePermille: 1000 };
}

function meters(from: GeoPoint, to: GeoPoint): number {
  return ellipsoidDistance(from.latitude, from.longitude, to.latitude, to.longitude);
}

const homeStarts: readonly ActivityEnds[] = [
  activity([0, 0], [8000, 0]),
  activity([40, -30], [-6000, 2000]),
  activity([-50, 20], [3000, 9000]),
  activity([10, 60], [0, -7000]),
  activity([-20, -50], [12000, 4000]),
];

describe("proposeZone", () => {
  it("offers a 300 m zone centered on the mean of five starts less than 150 m apart (PRV-014)", () => {
    const proposal = proposeZone(homeStarts, [], []);
    expect(proposal).not.toBeNull();
    if (proposal === null) return;
    expect(proposal.radiusMeters).toBe(zoneProposalRules.radiusMeters);
    expect(proposal.activities).toBe(5);
    expect(meters(proposal.center, at(-4, 0))).toBeLessThan(0.5);
  });

  it("needs five distinct activities: a loop from home counts once", () => {
    expect(proposeZone(homeStarts.slice(0, 4), [], [])).toBeNull();
    const loops = [activity([0, 0], [20, 10]), activity([30, 0], [0, 30]), activity([-10, 0], [0, -10]), activity([0, 40], [5, 5])];
    expect(proposeZone([...loops, activity([5000, 0], [6000, 0])], [], [])).toBeNull();
    expect(proposeZone([...loops, activity([5000, 0], [10, 10])], [], [])?.activities).toBe(5);
  });

  it("counts finishes as well as starts", () => {
    const finishes = homeStarts.map((ends) => ({ start: ends.end, end: ends.start }));
    expect(proposeZone([...finishes.slice(0, 3), ...homeStarts.slice(3)], [], [])?.activities).toBe(5);
  });

  it("ignores points spread wider than 150 m", () => {
    const spread = [0, 1, 2, 3, 4].map((index) => activity([index * 120, 0], [20000, 20000 + index * 1000]));
    expect(proposeZone(spread, [], [])).toBeNull();
  });

  it("proposes nothing where a zone already hides the place", () => {
    expect(proposeZone(homeStarts, [zoneAt(0, 0, 200)], [])).toBeNull();
    expect(proposeZone(homeStarts, [zoneAt(3000, 3000, 200)], [])?.activities).toBe(5);
  });

  it("proposes each place once and moves on to the next recurring place", () => {
    const work = [0, 1, 2, 3, 4, 5].map((index) => activity([20000 + index * 10, 0], [-30000, index * 5000]));
    const both = [...homeStarts, ...work];
    const first = proposeZone(both, [], []);
    expect(first?.activities).toBe(6);
    if (first === null) return;
    expect(meters(first.center, at(20025, 0))).toBeLessThan(0.5);
    const second = proposeZone(both, [], [first.center]);
    expect(second?.activities).toBe(5);
    if (second === null) return;
    expect(proposeZone(both, [], [first.center, second.center])).toBeNull();
  });
});
