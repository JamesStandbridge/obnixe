import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getConfig } from "expo/config";
import { compileModsAsync } from "expo/config-plugins";
import { beforeAll, describe, expect, it } from "vitest";

interface ManifestPermission {
  readonly $: Readonly<Record<string, string>>;
}

interface ModResults {
  readonly ios: { readonly infoPlist: Readonly<Record<string, unknown>> };
  readonly android: { readonly manifest: { readonly manifest: { readonly "uses-permission"?: readonly ManifestPermission[] } } };
}

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const moduleManifest = readFileSync(new URL("../modules/obnixe-tracker/android/src/main/AndroidManifest.xml", import.meta.url), "utf8");

let results: ModResults;

beforeAll(async () => {
  const { exp } = getConfig(projectRoot, { skipSDKVersionRequirement: true, isModdedConfig: true });
  const compiled = await compileModsAsync(exp, { projectRoot, platforms: ["ios", "android"], introspect: true, assertMissingModProviders: false });
  results = compiled._internal?.modResults as ModResults;
});

function declares(permission: string): string | null {
  return new RegExp(`<uses-permission android:name="android\\.permission\\.${permission}"[^>]*/>`).exec(moduleManifest)?.[0] ?? null;
}

describe("location permission (PRV-001)", () => {
  it("asks for the position while the app is in use only", () => {
    const plist = results.ios.infoPlist;
    expect(plist.NSLocationWhenInUseUsageDescription).toEqual(expect.any(String));
    expect(plist).not.toHaveProperty("NSLocationAlwaysAndWhenInUseUsageDescription");
    expect(plist).not.toHaveProperty("NSLocationAlwaysUsageDescription");
    expect(plist.UIBackgroundModes).toEqual(expect.arrayContaining(["location", "bluetooth-central"]));
    expect(declares("ACCESS_FINE_LOCATION")).not.toBeNull();
    expect(declares("ACCESS_COARSE_LOCATION")).not.toBeNull();
    expect(declares("ACCESS_BACKGROUND_LOCATION")).toBeNull();
    const stripped = results.android.manifest.manifest["uses-permission"]?.find((permission) => permission.$["android:name"] === "android.permission.ACCESS_BACKGROUND_LOCATION");
    expect(stripped?.$["tools:node"]).toBe("remove");
  });
});

describe("permission texts (PRV-004, PRV-006)", () => {
  it("explains each permission in French, as the spec words it", () => {
    expect(results.ios.infoPlist).toMatchObject({
      NSLocationWhenInUseUsageDescription: "Obnixe utilise ta position pendant une activité que tu enregistres, pour mesurer distance, allure et dénivelé et tracer ta carte. Ta trace reste sur ce téléphone.",
      NSMotionUsageDescription: "Obnixe lit le baromètre et le podomètre pendant une activité pour mesurer ton dénivelé et ta cadence.",
      NSBluetoothAlwaysUsageDescription: "Obnixe se connecte à ta montre ou à ta ceinture pour afficher ta fréquence cardiaque pendant l'activité.",
    });
  });

  it("scans for heart-rate sources without deriving a location", () => {
    expect(declares("BLUETOOTH_SCAN")).toContain('android:usesPermissionFlags="neverForLocation"');
    expect(declares("BLUETOOTH_CONNECT")).not.toBeNull();
    expect(declares("ACTIVITY_RECOGNITION")).not.toBeNull();
  });
});
