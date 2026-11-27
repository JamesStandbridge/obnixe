const { ServerResponse } = require("node:http");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.sourceExts.push("sql");
config.resolver.assetExts.push("wasm");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && moduleName === "expo-secure-store") return { type: "sourceFile", filePath: path.join(__dirname, "web/expoSecureStore.ts") };
  return context.resolveRequest(context, moduleName, platform);
};

// expo-sqlite on web needs a cross-origin isolated document. Expo CLI serves index.html ahead of Metro's middleware, out of
// reach of `server.enhanceMiddleware`, so the dev server sets the headers on every response it writes.
const writeHead = ServerResponse.prototype.writeHead;
ServerResponse.prototype.writeHead = function writeHeadIsolated(...args) {
  this.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  this.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  return writeHead.apply(this, args);
};

module.exports = config;
