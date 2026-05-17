// Lazy/guarded loader for the local piper-tts native module.
// In Expo Go preview, the native module is absent and a top-level require
// would crash. We require it only after checking NativeModules.TTSManager.
import { NativeModules } from 'react-native';

export type PiperNative = {
  loadVoice: (modelPath: string, configJson: string, espeakDataPath: string) => Promise<{
    sampleRate: number;
    lengthScale: number;
    noiseScale: number;
    noiseW: number;
    languageCode: string;
    languageName: string;
    numSpeakers: number;
    numSymbols: number;
    espeakVoice: string;
  }>;
  unloadVoice: () => Promise<unknown>;
  generateAndPlay: (text: string, sid: number, speed: number) => Promise<unknown>;
  stopPlayback: () => Promise<unknown>;
  initializeTTS?: (sr: number, ch: number, configJson: string) => Promise<unknown>;
  deinitialize?: () => Promise<unknown>;
  startPlaybackSession: (info: { title?: string; author?: string | null; coverBase64?: string | null; isPlaying?: boolean }) => Promise<unknown>;
  updatePlaybackSession: (info: { title?: string; author?: string | null; coverBase64?: string | null; isPlaying?: boolean }) => Promise<unknown>;
  stopPlaybackSession: () => Promise<unknown>;
};

let cached: PiperNative | null | undefined;

export function getPiperNative(): PiperNative | null {
  if (cached !== undefined) return cached;
  try {
    if (!NativeModules || !NativeModules.TTSManager) {
      cached = null;
      return null;
    }
    cached = NativeModules.TTSManager as PiperNative;
    return cached;
  } catch (e) {
    console.warn('[Piper] Native module load failed:', e);
    cached = null;
    return null;
  }
}

export function isPiperAvailable(): boolean {
  return getPiperNative() !== null;
}
