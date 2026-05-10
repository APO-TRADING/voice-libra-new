// Lazy/guarded loader for react-native-sherpa-onnx-offline-tts.
// In Expo Go preview, the native module is absent and the package's
// top-level `new NativeEventEmitter(undefined)` would crash.
// We require it only after checking NativeModules.TTSManager is present.
import { NativeModules } from 'react-native';

export type SherpaTTS = {
  initialize: (modelDirOrId: string) => Promise<unknown>;
  generateAndPlay: (text: string, sid: number, speed: number) => Promise<unknown>;
  generateAndSave: (text: string, path?: string, fileType?: 'wav') => Promise<unknown>;
  deinitialize: () => Promise<unknown>;
};

let cached: SherpaTTS | null | undefined;

export function getSherpaTTS(): SherpaTTS | null {
  if (cached !== undefined) return cached;
  try {
    if (!NativeModules || !NativeModules.TTSManager) {
      cached = null;
      return null;
    }
    // Native module exists → safe to require the JS wrapper.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-sherpa-onnx-offline-tts');
    cached = (mod?.default ?? mod) as SherpaTTS;
    return cached;
  } catch (e) {
    console.warn('[Piper] Native module load failed, falling back to device TTS:', e);
    cached = null;
    return null;
  }
}

export function isPiperAvailable(): boolean {
  return getSherpaTTS() !== null;
}
