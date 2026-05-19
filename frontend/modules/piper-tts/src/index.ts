// piper-tts: JavaScript bridge for the local native module.
//
// This file is intentionally minimal — the app does NOT import from
// 'piper-tts' as a package. Instead, src/audio/piperBridge.ts reads
// NativeModules.TTSManager directly. We keep this entry so that:
//   1. The package.json `main` field has a valid target file.
//   2. Future consumers can `import { isPiperAvailable } from 'piper-tts'`.
//
// API surface (mirrored in src/audio/piperBridge.ts):
//   loadVoice(modelPath, configJson, espeakDataPath) -> {sampleRate, ...}
//   synthesizeToFile(text, sid, speed) -> {path, sampleRate, durationMs, ...}
//   stopPlayback() -> void           (cancels in-flight synthesis)
//   deleteWavFile(path) -> boolean
//   cleanupWavCache() -> number
//   unloadVoice() -> void
import { NativeModules } from 'react-native';

const { TTSManager } = NativeModules as {
  TTSManager?: {
    loadVoice: (
      modelPath: string,
      configJson: string,
      espeakDataPath: string,
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
      executionProvider?: string;
    }>;
    unloadVoice: () => Promise<void>;
    synthesizeToFile: (text: string, sid: number, speed: number) => Promise<{
      path: string;
      sampleRate: number;
      numSamples: number;
      durationMs: number;
      synthMs: number;
    }>;
    stopPlayback: () => Promise<void>;
    deleteWavFile: (path: string) => Promise<boolean>;
    cleanupWavCache: () => Promise<number>;
  };
};

export function isPiperAvailable(): boolean {
  return !!TTSManager && typeof TTSManager.loadVoice === 'function';
}

export function getPiperNative() {
  return TTSManager || null;
}

export default TTSManager;
