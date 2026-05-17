// Multi-voice asset registry.
//
// Each voice has TWO files bundled in the APK via expo-asset:
//   1. model.onnx       — the Piper VITS ONNX model (≈30 MB for x_low)
//   2. model.onnx.json  — the voice config (phoneme_id_map, sample_rate, ...)
//
// To add a NEW voice:
//   1. Drop the two files into assets/piper/voices/<voice_id>/
//   2. Add an entry to assets/piper/voices.json with display name + metadata
//   3. Add an entry to the PIPER_VOICES map below (require() the two files)
//   4. Rebuild the APK (EAS) so the new assets get bundled
//
// At runtime, the Settings tab scans this map and lets the user pick one.
import voicesManifest from '../../assets/piper/voices.json';

export type VoiceMeta = {
  id: string;
  name: string;
  language: string;
  language_code: string;
  quality: string;
  size_mb: number;
  description: string;
  flag?: string;
};

export const VOICES_MANIFEST = voicesManifest as { default_voice: string; voices: VoiceMeta[] };

export const DEFAULT_VOICE_ID = VOICES_MANIFEST.default_voice;

export type VoiceAsset = {
  /** require() handle for the .onnx model (resolved by expo-asset). */
  model: number;
  /**
   * Parsed JSON sidecar (Metro inlines .json files as JS objects). We pass
   * its stringified form to the native side via native.loadVoice().
   */
  config: Record<string, unknown>;
};

// CRITICAL: each require() path MUST be a static string literal so the
// Metro bundler can statically resolve the asset.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const PIPER_VOICES: Record<string, VoiceAsset> = {
  riccardo: {
    model: require('../../assets/piper/voices/riccardo/model.onnx'),
    config: require('../../assets/piper/voices/riccardo/model.onnx.json'),
  },
  beppe: {
    model: require('../../assets/piper/voices/beppe/model.onnx'),
    config: require('../../assets/piper/voices/beppe/model.onnx.json'),
  },
};

// espeak-ng-data is shared by all voices and ships as a single .bin zip.
export const ESPEAK_DATA_ZIP = require('../../assets/piper/espeak-ng-data.bin');
