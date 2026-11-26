import type { PaletteName } from "@/ui/tokens";

/** Color stops spread evenly over [0, 1]. */
export type Ramp = readonly string[];

export interface TrackPalette {
  /** Slow to fast: pace and speed. */
  readonly effort: Ramp;
  /** Low to high. */
  readonly altitude: Ramp;
  /** Steep descent to steep climb, flat in the middle. */
  readonly grade: Ramp;
  /** Heart-rate zones 1 to 5. */
  readonly zones: readonly string[];
  /** Stretches without a known value. */
  readonly unknown: string;
}

export const trackPalettes: Readonly<Record<PaletteName, TrackPalette>> = {
  dark: {
    effort: ["#3d6dff", "#22cbe3", "#9ccc3b", "#e5ed32", "#ffb23e", "#ff4f2b"],
    altitude: ["#14954f", "#9ccc3b", "#e8c25c", "#c9874a", "#f1ede4"],
    grade: ["#2f6cff", "#7fb0ff", "#c9d1d9", "#ffb23e", "#e5392f"],
    zones: ["#8796aa", "#3d8bff", "#34d67f", "#ffb23e", "#ff4141"],
    unknown: "#6b7785",
  },
  sunlight: {
    effort: ["#1d48d8", "#0a8ea3", "#4f8a10", "#a79c00", "#c46a00", "#d0260b"],
    altitude: ["#0f7a40", "#557d0b", "#a5801f", "#8a5426", "#5c5248"],
    grade: ["#1d48d8", "#5b86e0", "#9aa3ad", "#c46a00", "#c8191e"],
    zones: ["#6c7889", "#2361d8", "#0f8447", "#c46a00", "#c8191e"],
    unknown: "#9aa3ad",
  },
};

/** Color of `value` in [0, 1] along a ramp, interpolated in sRGB. */
export function rampColor(ramp: Ramp, value: number): string {
  if (ramp.length === 1) return ramp[0] ?? "#000000";
  const position = Math.min(1, Math.max(0, value)) * (ramp.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(ramp.length - 1, lower + 1);
  const from = parseHex(ramp[lower] ?? "#000000");
  const to = parseHex(ramp[upper] ?? "#000000");
  const fraction = position - lower;
  const channel = (shift: number): string =>
    Math.round(((from >> shift) & 255) * (1 - fraction) + ((to >> shift) & 255) * fraction)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

function parseHex(color: string): number {
  return Number.parseInt(color.slice(1, 7), 16);
}
