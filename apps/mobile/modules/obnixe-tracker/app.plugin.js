const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod, withEntitlementsPlist, withInfoPlist, withXcodeProject } = require("expo/config-plugins");

const backgroundLocation = "android.permission.ACCESS_BACKGROUND_LOCATION";

const widgetTarget = "ObnixeTrackerWidget";
const widgetSourceDirs = [path.join(__dirname, "widget"), path.join(__dirname, "ios", "Shared")];
/** Compiled into the app as well, where the system runs the Live Activity intent. */
const appIntentSources = ["RecordingMarkIntent.swift", "MarkRequests.swift"];
const appGroupKey = "ObnixeTrackerAppGroup";
const deploymentTarget = "16.4";

/** PRV-004 and PRV-006 texts; PRV-003 for the temporary full accuracy purpose. */
const usageDescriptions = {
  NSLocationWhenInUseUsageDescription:
    "Obnixe utilise ta position pendant une activité que tu enregistres, pour mesurer distance, allure et dénivelé et tracer ta carte. Ta trace reste sur ce téléphone.",
  NSMotionUsageDescription: "Obnixe lit le baromètre et le podomètre pendant une activité pour mesurer ton dénivelé et ta cadence.",
  NSBluetoothAlwaysUsageDescription: "Obnixe se connecte à ta montre ou à ta ceinture pour afficher ta fréquence cardiaque pendant l'activité.",
  NSLocationTemporaryUsageDescriptionDictionary: {
    Recording: "Obnixe a besoin de ta position exacte pour mesurer distance, allure et dénivelé pendant l'activité que tu enregistres.",
  },
};

/**
 * Android: the recording runs in a foreground service started while the app is visible, so background location is
 * never needed (PRV-001): strip it from the merged manifest even if a dependency declares it. The module's own
 * manifest declares the permissions and the service it uses.
 */
function withAndroidTracker(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    manifest.$["xmlns:tools"] = "http://schemas.android.com/tools";
    const permissions = (manifest["uses-permission"] ?? []).filter((permission) => permission.$["android:name"] !== backgroundLocation);
    permissions.push({ $: { "android:name": backgroundLocation, "tools:node": "remove" } });
    manifest["uses-permission"] = permissions;
    return config;
  });
}

function bundleIdentifier(config) {
  const identifier = config.ios?.bundleIdentifier;
  if (!identifier) throw new Error("obnixe-tracker needs ios.bundleIdentifier");
  return identifier;
}

function appGroup(config) {
  return `group.${bundleIdentifier(config)}`;
}

function widgetSources() {
  return widgetSourceDirs.flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".swift"))
      .sort()
      .map((name) => path.join(dir, name)),
  );
}

/**
 * iOS: when-in-use location only (PRV-001) kept running in the background by the `location` mode, heart rate in the
 * background by `bluetooth-central`, and the Live Activity widget extension (REC-072), which shares an app group with
 * the app for the marks its buttons ask for.
 */
function withIosTracker(config) {
  config = withInfoPlist(config, (config) => {
    const plist = config.modResults;
    Object.assign(plist, usageDescriptions);
    delete plist.NSLocationAlwaysAndWhenInUseUsageDescription;
    delete plist.NSLocationAlwaysUsageDescription;
    plist.NSSupportsLiveActivities = true;
    plist.UIBackgroundModes = [...new Set([...(plist.UIBackgroundModes ?? []), "location", "bluetooth-central"])];
    plist[appGroupKey] = appGroup(config);
    return config;
  });
  config = withEntitlementsPlist(config, (config) => {
    const groups = config.modResults["com.apple.security.application-groups"] ?? [];
    config.modResults["com.apple.security.application-groups"] = [...new Set([...groups, appGroup(config)])];
    return config;
  });
  config = withDangerousMod(config, [
    "ios",
    (config) => {
      const dir = path.join(config.modRequest.platformProjectRoot, widgetTarget);
      fs.mkdirSync(dir, { recursive: true });
      for (const source of widgetSources()) fs.copyFileSync(source, path.join(dir, path.basename(source)));
      fs.writeFileSync(path.join(dir, "Info.plist"), widgetInfoPlist(appGroup(config)));
      fs.writeFileSync(path.join(dir, `${widgetTarget}.entitlements`), entitlementsPlist(appGroup(config)));
      return config;
    },
  ]);
  config = withXcodeProject(config, (config) => {
    addWidgetTarget(config.modResults, config);
    return config;
  });
  return withAppExtensionDeclaration(config);
}

function addWidgetTarget(project, config) {
  if (project.pbxTargetByName(widgetTarget)) return;
  const app = project.getFirstTarget();
  const sources = widgetSources().map((source) => path.basename(source));
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};
  const target = project.addTarget(widgetTarget, "app_extension", widgetTarget, `${bundleIdentifier(config)}.widget`);
  const appPhases = project.pbxNativeTargetSection()[app.uuid].buildPhases;
  const embed = appPhases.pop();
  appPhases.splice(appPhases.findIndex((phase) => phase.comment === "Resources") + 1, 0, embed);
  const group = project.addPbxGroup(sources, widgetTarget, widgetTarget);
  project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
  project.addBuildPhase(sources, "PBXSourcesBuildPhase", "Sources", target.uuid);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
  for (const child of group.pbxGroup.children) {
    if (appIntentSources.includes(child.comment)) addToSources(project, app.uuid, child.value, child.comment);
  }
  const appSettings = buildSettingsOf(project, app.uuid)[0] ?? {};
  for (const settings of buildSettingsOf(project, target.uuid)) {
    Object.assign(settings, {
      CLANG_ENABLE_MODULES: "YES",
      CODE_SIGN_ENTITLEMENTS: quoted(`${widgetTarget}/${widgetTarget}.entitlements`),
      CODE_SIGN_STYLE: "Automatic",
      CURRENT_PROJECT_VERSION: quoted(config.ios?.buildNumber ?? "1"),
      GENERATE_INFOPLIST_FILE: "NO",
      INFOPLIST_FILE: quoted(`${widgetTarget}/Info.plist`),
      IPHONEOS_DEPLOYMENT_TARGET: deploymentTarget,
      MARKETING_VERSION: quoted(config.version ?? "1.0.0"),
      PRODUCT_NAME: quoted("$(TARGET_NAME)"),
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: "1",
    });
    if (appSettings.DEVELOPMENT_TEAM) settings.DEVELOPMENT_TEAM = appSettings.DEVELOPMENT_TEAM;
  }
}

function addToSources(project, targetUuid, fileRef, name) {
  const buildFiles = project.pbxBuildFileSection();
  const uuid = project.generateUuid();
  buildFiles[uuid] = { isa: "PBXBuildFile", fileRef, fileRef_comment: name };
  buildFiles[`${uuid}_comment`] = `${name} in Sources`;
  project.pbxSourcesBuildPhaseObj(targetUuid).files.push({ value: uuid, comment: `${name} in Sources` });
}

function buildSettingsOf(project, targetUuid) {
  const listUuid = project.pbxNativeTargetSection()[targetUuid].buildConfigurationList;
  const configurations = project.pbxXCBuildConfigurationSection();
  return project.pbxXCConfigurationList()[listUuid].buildConfigurations.map(({ value }) => configurations[value].buildSettings);
}

function quoted(value) {
  return `"${value}"`;
}

/** Lets EAS create the widget's bundle identifier and provisioning profile before the Xcode project exists. */
function withAppExtensionDeclaration(config) {
  const eas = config.extra?.eas ?? {};
  const ios = eas.build?.experimental?.ios ?? {};
  const appExtensions = (ios.appExtensions ?? []).filter((extension) => extension.targetName !== widgetTarget);
  appExtensions.push({
    targetName: widgetTarget,
    bundleIdentifier: `${bundleIdentifier(config)}.widget`,
    entitlements: { "com.apple.security.application-groups": [appGroup(config)] },
  });
  config.extra = {
    ...config.extra,
    eas: { ...eas, build: { ...eas.build, experimental: { ...eas.build?.experimental, ios: { ...ios, appExtensions } } } },
  };
  return config;
}

function plistDocument(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
}

function widgetInfoPlist(group) {
  const entries = {
    CFBundleDevelopmentRegion: "$(DEVELOPMENT_LANGUAGE)",
    CFBundleDisplayName: "Obnixe",
    CFBundleExecutable: "$(EXECUTABLE_NAME)",
    CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: "$(PRODUCT_NAME)",
    CFBundlePackageType: "$(PRODUCT_BUNDLE_PACKAGE_TYPE)",
    CFBundleShortVersionString: "$(MARKETING_VERSION)",
    CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
    [appGroupKey]: group,
  };
  const strings = Object.entries(entries).map(([key, value]) => `  <key>${key}</key>\n  <string>${value}</string>`);
  const extension = "  <key>NSExtension</key>\n  <dict>\n    <key>NSExtensionPointIdentifier</key>\n    <string>com.apple.widgetkit-extension</string>\n  </dict>";
  return plistDocument([...strings, extension].join("\n"));
}

function entitlementsPlist(group) {
  return plistDocument(`  <key>com.apple.security.application-groups</key>\n  <array>\n    <string>${group}</string>\n  </array>`);
}

module.exports = function withObnixeTracker(config) {
  return withIosTracker(withAndroidTracker(config));
};
