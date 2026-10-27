import { posix, win32 } from "node:path";

export function platformPath(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function nonEmpty(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/** Per-user configuration directory: %APPDATA% on Windows, $XDG_CONFIG_HOME or ~/.config on macOS and Linux. */
export function userConfigDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  const path = platformPath(platform);
  if (platform === "win32") return nonEmpty(env.APPDATA) ?? path.join(home, "AppData", "Roaming");
  return nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(home, ".config");
}
