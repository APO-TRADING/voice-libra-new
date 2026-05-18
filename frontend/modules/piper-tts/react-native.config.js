// react-native.config.js — INSIDE the local module.
//
// This is what the React Native CLI autolinking script (used by Expo
// prebuild under the hood) reads to discover that this folder contains
// a native Android module, and where its sources live.
//
// Without this file the package would be discovered as JS-only and
// PiperTtsPackage would NEVER be registered in MainApplication.kt,
// resulting in NativeModules.TTSManager === undefined at runtime.
module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.beppeaudiobooks.pipertts.PiperTtsPackage;',
        packageInstance: 'new PiperTtsPackage()',
      },
      // iOS not yet implemented for piper-tts.
      ios: null,
    },
  },
};
