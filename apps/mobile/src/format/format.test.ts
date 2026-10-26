import { describe, expect, it } from "vitest";
import type { LocalDate } from "@obnixe/schema";
import { relativeDay, shortDate } from "@/format/dates";
import { formatClock, formatLongClock } from "@/format/durations";
import { capitalize, lowerFirst, plural, sessionTitle } from "@/format/labels";
import type { SessionTitleSource } from "@/format/labels";
import { formatInteger, formatNumber, formatSigned } from "@/format/numbers";

describe("numbers", () => {
  it("uses a decimal comma, grouped thousands and a real minus sign", () => {
    expect(formatNumber(1234.56)).toBe("1\u00a0234,6");
    expect(formatNumber(12.5, 2, 2)).toBe("12,50");
    expect(formatNumber(80)).toBe("80");
    expect(formatNumber(-3.25, 1)).toBe("−3,3");
    expect(formatNumber(-0.01)).toBe("0");
    expect(formatInteger(-1_234_567.4)).toBe("−1\u00a0234\u00a0567");
  });

  it("signs values that do not round to zero", () => {
    expect(formatSigned(2.5)).toBe("+2,5");
    expect(formatSigned(-2, 0)).toBe("−2");
    expect(formatSigned(0.04)).toBe("0");
  });
});

describe("durations", () => {
  it("writes clocks", () => {
    expect(formatClock(75.4)).toBe("1:15");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatLongClock(59 * 60 + 59)).toBe("59:59");
    expect(formatLongClock(3725)).toBe("1:02:05");
  });
});

describe("labels", () => {
  it("pluralizes and changes the case of the first letter", () => {
    expect(plural(1, "série")).toBe("1 série");
    expect(plural(0, "série")).toBe("0 série");
    expect(plural(1200, "rép.", "rép.")).toBe("1\u00a0200 rép.");
    expect(capitalize("écart")).toBe("Écart");
    expect(lowerFirst("Genou droit")).toBe("genou droit");
    expect(capitalize("")).toBe("");
  });

  it("titles sessions from the title, the program slot or the sport fields", () => {
    const base: SessionTitleSource = { sport: "strength", title: null, slotName: null, variantName: null, values: {} };
    expect(sessionTitle({ ...base, title: "Jambes" })).toBe("Jambes");
    expect(sessionTitle(base)).toBe("Musculation libre");
    expect(sessionTitle({ ...base, slotName: "Séance A", variantName: "Salle" })).toBe("Séance A · Salle");
    expect(sessionTitle({ ...base, sport: "run", values: { kind: "easy" } })).toBe("Course · footing");
    expect(sessionTitle({ ...base, sport: "run", slotName: "Footing" })).toBe("Footing");
    expect(sessionTitle({ ...base, sport: "hike", values: { kind: "trail", route: "GR20" } })).toBe("Rando · GR20");
    expect(sessionTitle({ ...base, sport: "climb", values: { place: "Arkose", discipline: "boulder" } })).toBe("Bloc · Arkose");
    expect(sessionTitle({ ...base, sport: "climb", values: {} })).toBe("Escalade");
  });
});

describe("dates", () => {
  const today = "2026-10-26" as LocalDate;

  it("names nearby days and dates older ones", () => {
    expect(relativeDay(today, today)).toBe("aujourd'hui");
    expect(relativeDay("2026-10-25" as LocalDate, today)).toBe("hier");
    expect(relativeDay("2026-10-24" as LocalDate, today)).toBe("avant-hier");
    expect(relativeDay("2026-10-21" as LocalDate, today)).toBe("mercredi");
    expect(relativeDay("2026-10-19" as LocalDate, today)).toBe("le 19 oct.");
    expect(relativeDay("2026-10-27" as LocalDate, today)).toBe("le 27 oct.");
    expect(shortDate("2026-02-03" as LocalDate)).toBe("3 févr.");
  });
});
