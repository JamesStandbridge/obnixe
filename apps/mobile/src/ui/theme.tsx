import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AccessibilityInfo, useColorScheme } from "react-native";
import { useLiveQuery } from "drizzle-orm/expo-sqlite";
import { settings } from "@obnixe/schema";
import type { Theme } from "@obnixe/schema";
import { db } from "@/data/database";
import { palettes } from "@/ui/tokens";
import type { Palette, PaletteName } from "@/ui/tokens";

export interface ThemeValue {
  readonly name: PaletteName;
  readonly colors: Palette;
  readonly reduceMotion: boolean;
}

const ThemeContext = createContext<ThemeValue>({ name: "dark", colors: palettes.dark, reduceMotion: false });

function resolvePalette(theme: Theme, scheme: "light" | "dark" | "unspecified" | null | undefined): PaletteName {
  switch (theme) {
    case "dark":
      return "dark";
    case "sunlight":
      return "sunlight";
    case "system":
      return scheme === "light" ? "sunlight" : "dark";
    default: {
      const unreachable: never = theme;
      return unreachable;
    }
  }
}

function useReduceMotion(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setEnabled);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setEnabled);
    return () => subscription.remove();
  }, []);
  return enabled;
}

interface ThemeProviderProps {
  readonly children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const initial = useMemo(() => db().select({ theme: settings.theme }).from(settings).get(), []);
  const { data } = useLiveQuery(db().select({ theme: settings.theme }).from(settings));
  const scheme = useColorScheme();
  const reduceMotion = useReduceMotion();
  const name = resolvePalette(data[0]?.theme ?? initial?.theme ?? "dark", scheme);
  return <ThemeContext.Provider value={{ name, colors: palettes[name], reduceMotion }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext);
}
