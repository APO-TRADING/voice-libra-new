// ─────────────────────────────────────────────────────────────────────
// PIPER MODEL ASSETS — EDIT THIS FILE WHEN YOU ADD YOUR MODEL.
//
// 1) Drop your files into /app/frontend/assets/piper/:
//      - beppe.onnx
//      - beppe.onnx.json
//      - tokens.txt              (required by sherpa-onnx)
//      - espeak-ng-data/         (folder, required by sherpa-onnx)
//
// 2) Uncomment the require() lines below to bundle them into the APK/IPA.
//
// 3) Build native projects:
//      cd /app/frontend
//      npx expo prebuild --clean
//      npx expo run:android      (or eas build --platform android)
//
// While these requires are commented out, the app runs in "preview" mode
// with the device fallback TTS. That keeps Expo Go working for UI testing.
// ─────────────────────────────────────────────────────────────────────

export type PiperAssets = {
  model: number;
  config: number;
  tokens: number;
};

export const PIPER_ASSETS: PiperAssets | null = null;

// ▼▼▼ TO ENABLE PIPER ON-DEVICE: replace `null` above with the export below ▼▼▼
//
// export const PIPER_ASSETS: PiperAssets = {
//   model:  require('../../assets/piper/beppe.onnx'),
//   config: require('../../assets/piper/beppe.onnx.json'),
//   tokens: require('../../assets/piper/tokens.txt'),
// };
//
// The espeak-ng-data folder is bundled automatically by the
// `sherpa-onnx-piper-plugin` config plugin (see app.json / plugins/).
