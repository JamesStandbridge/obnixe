import type { TextStyle } from "react-native";
import type { SportKey } from "@obnixe/schema";

export interface Palette {
  readonly bg: string;
  readonly surface: string;
  readonly surface2: string;
  readonly surfacePress: string;
  readonly controlBorder: string;
  readonly text: string;
  readonly text2: string;
  readonly text3: string;
  readonly line: string;
  readonly mark: string;
  readonly stepDone: string;
  readonly actBg: string;
  readonly actPress: string;
  readonly actInk: string;
  readonly warn: string;
  readonly warnInk: string;
  readonly stop: string;
  readonly stopInk: string;
  readonly scrim: string;
  readonly snackbarBg: string;
  readonly snackbarInk: string;
  readonly sheetBg: string;
  readonly brand: string;
  readonly brandDeep: string;
  readonly brandInk: string;
  readonly sport: Readonly<Record<SportKey, string>>;
  readonly sportDeep: Readonly<Record<SportKey, string>>;
  readonly sportInk: string;
}

export type PaletteName = "dark" | "sunlight";

export const palettes: Readonly<Record<PaletteName, Palette>> = {
  dark: {
    bg: "#0b0e11",
    surface: "#151a1f",
    surface2: "#1f252c",
    surfacePress: "#2a3139",
    controlBorder: "#56606b",
    text: "#f2f5f7",
    text2: "#b0b8c0",
    text3: "#828b94",
    line: "#ffffff14",
    mark: "#e5ed32",
    stepDone: "#828b94",
    actBg: "#e5ed32",
    actPress: "#cfd71d",
    actInk: "#12140a",
    warn: "#ffb23e",
    warnInk: "#1e1406",
    stop: "#e5392f",
    stopInk: "#fff6f5",
    scrim: "#000000a6",
    snackbarBg: "#f2f5f7",
    snackbarInk: "#0b0e11",
    sheetBg: "#151a1f",
    brand: "#e5ed32",
    brandDeep: "#8c9312",
    brandInk: "#12140a",
    sport: { strength: "#5b86ff", run: "#ff6a2b", hike: "#e8a84c", swim: "#22cbe3", bike: "#ff4f8b", climb: "#34d67f", yoga: "#a173ff" },
    sportDeep: { strength: "#2a4fd6", run: "#c8430f", hike: "#a8701f", swim: "#0d8ea3", bike: "#c22760", climb: "#14954f", yoga: "#6a3fd0" },
    sportInk: "#0b0e11",
  },
  sunlight: {
    bg: "#eceee7",
    surface: "#ffffff",
    surface2: "#dfe2da",
    surfacePress: "#cfd3c9",
    controlBorder: "#6f757b",
    text: "#0b0e11",
    text2: "#33383e",
    text3: "#545a60",
    line: "#0000001c",
    mark: "#4f6b00",
    stepDone: "#6f757b",
    actBg: "#12140a",
    actPress: "#2a2d1c",
    actInk: "#e5ed32",
    warn: "#9a5800",
    warnInk: "#fdf7f2",
    stop: "#c8191e",
    stopInk: "#fff6f5",
    scrim: "#13161a59",
    snackbarBg: "#12140a",
    snackbarInk: "#f2f5f7",
    sheetBg: "#ffffff",
    brand: "#e5ed32",
    brandDeep: "#8c9312",
    brandInk: "#12140a",
    sport: { strength: "#2350d8", run: "#d2470c", hike: "#94600f", swim: "#007f93", bike: "#c41d5b", climb: "#0f8447", yoga: "#6c3cc9" },
    sportDeep: { strength: "#173a9e", run: "#9a3207", hike: "#6b4409", swim: "#005766", bike: "#8d1240", climb: "#095e32", yoga: "#4c2694" },
    sportInk: "#ffffff",
  },
};

/** Expects a #rrggbb color. */
export function wash(color: string, alpha = 0.16): string {
  return `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

export const radii = { control: 10, panel: 16, sheet: 26, tag: 6 } as const;

/** Size of the slanted corner cut taken from the logo's 45 degree angles. */
export const bevels = { button: 14, card: 22, tile: 16 } as const;

export const durations = { press: 90, state: 180, sheet: 280, reveal: 420 } as const;

export const layout = { gutter: 16, tabbarHeight: 68, hitSlop: 44, borderControl: 1.5 } as const;

export const fonts = {
  brand600: "Outfit_600SemiBold",
  brand700: "Outfit_700Bold",
  brand800: "Outfit_800ExtraBold",
  text400: "SofiaSans_400Regular",
  text500: "SofiaSans_500Medium",
  text600: "SofiaSans_600SemiBold",
  text700: "SofiaSans_700Bold",
  figure500: "SofiaSansCondensed_500Medium",
  figure600: "SofiaSansCondensed_600SemiBold",
  figure700: "SofiaSansCondensed_700Bold",
  figure800: "SofiaSansCondensed_800ExtraBold",
} as const;

export type TypeVariant =
  | "title"
  | "sheetTitle"
  | "body"
  | "bodyStrong"
  | "label"
  | "small"
  | "caption"
  | "eyebrow"
  | "sectionTitle"
  | "heading"
  | "value"
  | "figure"
  | "display";

export const type: Readonly<Record<TypeVariant, TextStyle>> = {
  title: { fontFamily: fonts.brand800, fontSize: 28, lineHeight: 32, letterSpacing: -0.6 },
  sheetTitle: { fontFamily: fonts.brand700, fontSize: 22, lineHeight: 26, letterSpacing: -0.3 },
  body: { fontFamily: fonts.text400, fontSize: 16, lineHeight: 23 },
  bodyStrong: { fontFamily: fonts.text600, fontSize: 16, lineHeight: 21 },
  label: { fontFamily: fonts.text600, fontSize: 15, lineHeight: 18 },
  small: { fontFamily: fonts.text500, fontSize: 14, lineHeight: 18 },
  caption: { fontFamily: fonts.text600, fontSize: 13, lineHeight: 16 },
  eyebrow: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 13, letterSpacing: 1.1, textTransform: "uppercase" },
  sectionTitle: { fontFamily: fonts.text600, fontSize: 14, lineHeight: 17 },
  heading: { fontFamily: fonts.brand700, fontSize: 19, lineHeight: 23, letterSpacing: -0.2 },
  value: { fontFamily: fonts.figure700, fontSize: 18, lineHeight: 20 },
  figure: { fontFamily: fonts.figure800, fontSize: 34, lineHeight: 40, letterSpacing: -0.3 },
  display: { fontFamily: fonts.figure800, fontSize: 72, lineHeight: 74, letterSpacing: -1.4 },
};
