const { withAndroidManifest } = require("expo/config-plugins");

const backgroundLocation = "android.permission.ACCESS_BACKGROUND_LOCATION";

/**
 * The recording runs in a foreground service started while the app is visible, so background location is never
 * needed (PRV-001): strip it from the merged manifest even if a dependency declares it. The module's own manifest
 * declares the permissions and the service it uses.
 */
module.exports = function withObnixeTracker(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    const permissions = (manifest["uses-permission"] ?? []).filter((permission) => permission.$["android:name"] !== backgroundLocation);
    permissions.push({ $: { "android:name": backgroundLocation, "tools:node": "remove" } });
    manifest["uses-permission"] = permissions;
    return config;
  });
};
