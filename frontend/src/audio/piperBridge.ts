// Lazy/guarded loader for the local piper-tts native module.
// In Expo Go preview, the native module is absent and a top-level require
// would crash. We require it only after checking NativeModules.TTSManager.
import { NativeModules } from 'react-native';

export type PiperNative = {
  loadVoice: (
    modelPath: string,
    configJson: string,
    espeakDataPath: string,
    /** Optional engine options. New in v2.1 — Kotlin side gracefully
     *  ignores it if missing (backwards compatible with old JS bundles). */
    options?: { useNnapi?: boolean },
  ) => Promise<{
    sampleRate: number;
    lengthScale: number;
    noiseScale: number;
    noiseW: number;
    languageCode: string;
    languageName: string;
    numSpeakers: number;
    numSymbols: number;
    espeakVoice: string;
    nativePhonemizer: boolean;
    /** Base language code of the loaded phoneme dictionary, e.g. "it","en","es". */
    phonemesDictLang?: string;
    /** Number of word→IPA entries in the loaded dictionary (0 if none). */
    phonemesDictSize?: number;
    /** ONNX Runtime execution provider actually used ("NNAPI" or "CPU"). */
    executionProvider?: string;
  }>;
  unloadVoice: () => Promise<unknown>;
  /**
   * Synthesize text -> WAV file in the app's cache dir.
   * Returns { path: absolute path to the .wav, sampleRate, numSamples, durationMs, synthMs }.
   */
  synthesizeToFile: (text: string, sid: number, speed: number) => Promise<{
    path: string;
    sampleRate: number;
    numSamples: number;
    durationMs: number;
    synthMs: number;
  }>;
  /** Cancel any in-flight synthesis. */
  stopPlayback: () => Promise<unknown>;
  /** Delete one WAV file (after the track finished playing). */
  deleteWavFile: (path: string) => Promise<boolean>;
  /** Nuke the whole WAV cache directory. */
  cleanupWavCache: () => Promise<number>;
  // Legacy compatibility shims
  initializeTTS?: (sr: number, ch: number, configJson: string) => Promise<unknown>;
  deinitialize?: () => Promise<unknown>;
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
