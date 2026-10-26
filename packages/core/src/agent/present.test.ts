import { describe, expect, it } from "vitest";
import { frenchDistance, frenchDuration, frenchSpan, localDateIn } from "./format.ts";
import { callTag, connectionRecap, historyTitle, readsLine } from "./present.ts";

describe("format", () => {
  it("writes French distances, durations and spans", () => {
    expect(frenchDistance(9200)).toBe("9,2 km");
    expect(frenchDistance(32400)).toBe("32 km");
    expect(frenchDistance(800)).toBe("800 m");
    expect(frenchDuration(2700)).toBe("45 min");
    expect(frenchDuration(5400)).toBe("1 h 30");
    expect(frenchSpan("2026-10-03", "2026-10-30")).toBe("du 3 au 30 octobre");
    expect(frenchSpan("2026-09-28", "2026-10-01")).toBe("du 28 septembre au 1er octobre");
  });

  it("finds the local day in a time zone", () => {
    expect(localDateIn(Date.parse("2026-10-24T23:30:00Z"), "Europe/Paris")).toBe("2026-10-25");
    expect(localDateIn(Date.parse("2026-10-24T23:30:00Z"), "UTC")).toBe("2026-10-24");
  });
});

describe("present", () => {
  it("tags and titles calls like the activity screens", () => {
    expect(callTag({ tool: "get_history", kind: "read", summary: "x", versionNumber: null })).toBe("Lecture");
    expect(callTag({ tool: "upsert_program", kind: "write", summary: "x", versionNumber: 7 })).toBe("Modification");
    expect(callTag({ tool: "upsert_program", kind: "write", summary: "x", versionNumber: 1 })).toBe("Ajout");
    expect(callTag({ tool: "log_activity", kind: "write", summary: "x", versionNumber: null })).toBe("Ajout");
    expect(historyTitle({ tool: "upsert_program", kind: "write", summary: "Rowing haltère au lieu du tirage menton", versionNumber: 7 })).toBe("v7 · rowing haltère au lieu du tirage menton");
    expect(historyTitle({ tool: "log_activity", kind: "write", summary: "Course du 12 octobre · 9,2 km", versionNumber: null })).toBe("Course du 12 octobre · 9,2 km");
  });

  it("summarises reads and connections", () => {
    expect(
      readsLine([
        { tool: "get_history", kind: "read", summary: "Historique des 56 derniers jours" },
        { tool: "get_program", kind: "read", summary: "Base hiver" },
        { tool: "get_program", kind: "read", summary: "Base hiver" },
        { tool: "log_activity", kind: "write", summary: "Course" },
      ]),
    ).toBe("Lu : historique des 56 derniers jours, Base hiver");
    expect(readsLine([])).toBeNull();
    expect(connectionRecap("Cursor", 3, 2, 29 * 60_000)).toBe("Cursor · 3 lectures, 2 modifications en 29 min");
    expect(connectionRecap("Codex", 1, 0, 10_000)).toBe("Codex · 1 lecture, 0 modification en 1 min");
  });
});
