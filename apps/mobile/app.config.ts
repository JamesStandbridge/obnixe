import type { ConfigContext, ExpoConfig } from "expo/config";

type Variant = "production" | "development";

const variant: Variant = process.env.APP_VARIANT === "development" ? "development" : "production";

const developmentId = "com.jamesstandbridge.obnixe.dev";

/**
 * `app.json` holds the production app. `APP_VARIANT=development` turns it into Obnixe Dev, a development client with its
 * own id, scheme and icon that installs next to the production app without sharing any of its data.
 */
export default function appConfig({ config }: ConfigContext): ExpoConfig {
  const { name, slug } = config;
  if (name === undefined || slug === undefined) throw new Error("app.json needs expo.name and expo.slug");
  const base: ExpoConfig = { ...config, name, slug };
  switch (variant) {
    case "production":
      return { ...base, plugins: [...(base.plugins ?? []), ["expo-dev-client", { addGeneratedScheme: false }]] };
    case "development":
      return {
        ...base,
        name: "Obnixe Dev",
        scheme: "obnixe-dev",
        icon: "./assets/icon-dev.png",
        ios: { ...base.ios, bundleIdentifier: developmentId },
        android: {
          ...base.android,
          package: developmentId,
          adaptiveIcon: { ...base.android?.adaptiveIcon, backgroundImage: "./assets/android-icon-background-dev.png" },
        },
        plugins: [...(base.plugins ?? []), "expo-dev-client"],
      };
    default: {
      const unreachable: never = variant;
      return unreachable;
    }
  }
}
