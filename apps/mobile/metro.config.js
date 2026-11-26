const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.sourceExts.push("sql");
config.resolver.assetExts.push("wasm");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && moduleName === "expo-secure-store") return { type: "sourceFile", filePath: path.join(__dirname, "web/expoSecureStore.ts") };
  return context.resolveRequest(context, moduleName, platform);
};
config.server.enhanceMiddleware = (middleware) => (request, response, next) => {
  response.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  middleware(request, response, next);
};

module.exports = config;
