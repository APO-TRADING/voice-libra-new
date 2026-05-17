// metro.config.js
const { getDefaultConfig } = require("expo/metro-config");
const path = require('path');
const { FileStore } = require('metro-cache');

const config = getDefaultConfig(__dirname);

// Allow Piper assets (.onnx model + .zip espeak-ng-data) to be bundled via require().
// .txt is already in defaults; .onnx and .zip are not.
const extra = ['onnx', 'zip', 'bin', 'txt'];
config.resolver.assetExts = Array.from(new Set([...(config.resolver.assetExts || []), ...extra]));
config.resolver.sourceExts = (config.resolver.sourceExts || []).filter((e) => !extra.includes(e));

// Enable `require.context()` for the Piper voices auto-discovery in
// src/audio/piperAssets.ts. This lets the user drop a new voice folder
// in assets/piper/voices/ and have it picked up at the next rebuild
// without editing any source file.
config.transformer = config.transformer || {};
config.transformer.unstable_allowRequireContext = true;

// Stub `canvas` (Node native package required by pdfjs-dist for rendering).
// We only need text extraction so an empty module is sufficient.
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  canvas: require('path').resolve(__dirname, 'src/audio/canvas-stub.js'),
};

// Use a stable on-disk store (shared across web/android)
const root = process.env.METRO_CACHE_ROOT || path.join(__dirname, '.metro-cache');
config.cacheStores = [
  new FileStore({ root: path.join(root, 'cache') }),
];


// // Exclude unnecessary directories from file watching
// config.watchFolders = [__dirname];
// config.resolver.blacklistRE = /(.*)\/(__tests__|android|ios|build|dist|.git|node_modules\/.*\/android|node_modules\/.*\/ios|node_modules\/.*\/windows|node_modules\/.*\/macos)(\/.*)?$/;

// // Alternative: use a more aggressive exclusion pattern
// config.resolver.blacklistRE = /node_modules\/.*\/(android|ios|windows|macos|__tests__|\.git|.*\.android\.js|.*\.ios\.js)$/;

// Reduce the number of workers to decrease resource usage
config.maxWorkers = 2;

module.exports = config;
