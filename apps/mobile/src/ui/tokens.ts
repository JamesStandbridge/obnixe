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
  readonly sport: Readonly<Record<SportKey, string>>;
}

export type PaletteName = "dark" | "sunlight";

export const palettes: Readonly<Record<PaletteName, Palette>> = {
  dark: {
    bg: "#0c1013",
    surface: "#161a1e",
    surface2: "#202529",
    surfacePress: "#2c3136",
    controlBorder: "#65696f",
    text: "#ebeff2",
    text2: "#b3b8be",
    text3: "#888d92",
    line: "#ffffff14",
    mark: "#e5ed32",
    stepDone: "#888d92",
    actBg: "#e5ed32",
    actPress: "#ced51f",
    actInk: "#161707",
    warn: "#f5ae39",
    warnInk: "#1e1406",
    stop: "#d02c2a",
    stopInk: "#fff6f5",
    scrim: "#0000008c",
    snackbarBg: "#ebeff2",
    snackbarInk: "#0c1013",
    sheetBg: "#161a1e",
    sport: { strength: "#8fb3ff", run: "#ff7a45", hike: "#d2ad6b", swim: "#3fd0e0", bike: "#ff6f9c", climb: "#5ad991", yoga: "#c8a4ff" },
  },
  sunlight: {
    bg: "#f5f7f9",
    surface: "#d5dade",
    surface2: "#c6cbd1",
    surfacePress: "#b5bbc2",
    controlBorder: "#7c8186",
    text: "#0c1014",
    text2: "#34383d",
    text3: "#4e5358",
    line: "#0000001f",
    mark: "#476706",
    stepDone: "#7c8186",
    actBg: "#161707",
    actPress: "#292a19",
    actInk: "#e3e41b",
    warn: "#915200",
    warnInk: "#fdf7f2",
    stop: "#c2181d",
    stopInk: "#fff6f5",
    scrim: "#13161a59",
    snackbarBg: "#13161a",
    snackbarInk: "#eff2f5",
    sheetBg: "#f5f7f9",
    sport: { strength: "#2c56c9", run: "#c4420c", hike: "#8a5f18", swim: "#00788a", bike: "#bd1f5c", climb: "#11804a", yoga: "#7440c0" },
  },
};

/** Expects a #rrggbb color. */
export function wash(color: string, alpha = 0.16): string {
  return `${color}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
}

export const radii = { control: 8, panel: 12, sheet: 20, tag: 4 } as const;

export const durations = { press: 90, state: 180, sheet: 280 } as const;

export const layout = { gutter: 16, tabbarHeight: 64, hitSlop: 44, borderControl: 1.5 } as const;

export const fonts = {
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
  | "value"
  | "figure"
  | "display";

export const type: Readonly<Record<TypeVariant, TextStyle>> = {
  title: { fontFamily: fonts.text700, fontSize: 26, lineHeight: 29, letterSpacing: -0.4 },
  sheetTitle: { fontFamily: fonts.text700, fontSize: 22, lineHeight: 25 },
  body: { fontFamily: fonts.text400, fontSize: 16, lineHeight: 23 },
  bodyStrong: { fontFamily: fonts.text600, fontSize: 16, lineHeight: 21 },
  label: { fontFamily: fonts.text600, fontSize: 15, lineHeight: 18 },
  small: { fontFamily: fonts.text500, fontSize: 14, lineHeight: 18 },
  caption: { fontFamily: fonts.text600, fontSize: 13, lineHeight: 16 },
  eyebrow: { fontFamily: fonts.text700, fontSize: 12, lineHeight: 12, letterSpacing: 0.96, textTransform: "uppercase" },
  sectionTitle: { fontFamily: fonts.text600, fontSize: 14, lineHeight: 17 },
  value: { fontFamily: fonts.figure700, fontSize: 18, lineHeight: 20 },
  figure: { fontFamily: fonts.figure800, fontSize: 34, lineHeight: 40, letterSpacing: -0.3 },
  display: { fontFamily: fonts.figure800, fontSize: 72, lineHeight: 74, letterSpacing: -1.4 },
};
