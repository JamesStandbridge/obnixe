const fs = require("node:fs");
const path = require("node:path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const source = path.join(__dirname, "..", "public", "maps");

function copyMapAssets(target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
}

/** Ships public/maps (glyphs, sprites, overlay images) as native resources, read by MapLibre through asset://maps. */
function withMapAssets(config) {
  config = withDangerousMod(config, [
    "android",
    (mod) => {
      copyMapAssets(path.join(mod.modRequest.platformProjectRoot, "app", "src", "main", "assets", "maps"));
      return mod;
    },
  ]);
  config = withDangerousMod(config, [
    "ios",
    (mod) => {
      copyMapAssets(path.join(mod.modRequest.platformProjectRoot, mod.modRequest.projectName, "maps"));
      return mod;
    },
  ]);
  return withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const { projectName } = mod.modRequest;
    const folder = `${projectName}/maps`;
    if (!project.hasFile(folder)) {
      const file = project.addResourceFile(folder, { lastKnownFileType: "folder" }, project.findPBXGroupKey({ name: projectName }));
      const reference = project.pbxFileReferenceSection()[file.fileRef];
      delete reference.fileEncoding;
      delete reference.explicitFileType;
    }
    return mod;
  });
}

module.exports = withMapAssets;
