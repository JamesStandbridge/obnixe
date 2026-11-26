const { withAndroidManifest, withInfoPlist } = require("expo/config-plugins");

/** What watches, apps and file managers label GPX, TCX, FIT and Garmin Connect ZIP files with. */
const activityMimeTypes = [
  "application/gpx+xml",
  "application/vnd.garmin.tcx+xml",
  "application/vnd.ant.fit",
  "application/fit",
  "application/octet-stream",
  "application/zip",
  "application/gzip",
  "application/xml",
  "text/xml",
];

const activityTypes = [
  { identifier: "com.topografix.gpx", description: "GPS Exchange Format", conformsTo: ["public.xml"], extension: "gpx", mimeType: "application/gpx+xml" },
  { identifier: "com.garmin.tcx", description: "Training Center XML", conformsTo: ["public.xml"], extension: "tcx", mimeType: "application/vnd.garmin.tcx+xml" },
  { identifier: "com.garmin.fit", description: "Flexible and Interoperable Data Transfer", conformsTo: ["public.data"], extension: "fit", mimeType: "application/vnd.ant.fit" },
];
const archiveTypes = ["public.zip-archive", "org.gnu.gnu-zip-archive"];
const documentTypeName = "Activité GPS";

const androidName = (name) => ({ $: { "android:name": name } });

function intentFilter(action, schemes) {
  return {
    $: { "android:label": documentTypeName },
    action: [androidName(action)],
    category: [androidName("android.intent.category.DEFAULT")],
    data: [...schemes.map((scheme) => ({ $: { "android:scheme": scheme } })), ...activityMimeTypes.map((mimeType) => ({ $: { "android:mimeType": mimeType } }))],
  };
}

/** IO-051, Android: Obnixe in "open with" (`VIEW`) and in the share sheet (`SEND`, turned into `VIEW` by the package). */
function withAndroidIntake(config) {
  return withAndroidManifest(config, (config) => {
    const activity = config.modResults.manifest.application?.[0]?.activity?.find((entry) => entry.$["android:name"] === ".MainActivity");
    if (!activity) throw new Error("obnixe-intake needs the MainActivity");
    const filters = (activity["intent-filter"] ?? []).filter((filter) => filter.$?.["android:label"] !== documentTypeName);
    activity["intent-filter"] = [...filters, intentFilter("android.intent.action.VIEW", ["content", "file"]), intentFilter("android.intent.action.SEND", [])];
    return config;
  });
}

/** IO-051, iOS: Obnixe in "open in" for activity files, copied into `Documents/Inbox` before the app gets them. */
function withIosIntake(config) {
  return withInfoPlist(config, (config) => {
    const plist = config.modResults;
    const identifiers = activityTypes.map((type) => type.identifier);
    plist.UTImportedTypeDeclarations = [
      ...(plist.UTImportedTypeDeclarations ?? []).filter((declaration) => !identifiers.includes(declaration.UTTypeIdentifier)),
      ...activityTypes.map((type) => ({
        UTTypeIdentifier: type.identifier,
        UTTypeDescription: type.description,
        UTTypeConformsTo: type.conformsTo,
        UTTypeTagSpecification: { "public.filename-extension": [type.extension], "public.mime-type": [type.mimeType] },
      })),
    ];
    plist.CFBundleDocumentTypes = [
      ...(plist.CFBundleDocumentTypes ?? []).filter((documentType) => documentType.CFBundleTypeName !== documentTypeName),
      { CFBundleTypeName: documentTypeName, CFBundleTypeRole: "Viewer", LSHandlerRank: "Alternate", LSItemContentTypes: [...identifiers, ...archiveTypes] },
    ];
    plist.LSSupportsOpeningDocumentsInPlace = false;
    return config;
  });
}

module.exports = function withObnixeIntake(config) {
  return withIosIntake(withAndroidIntake(config));
};
