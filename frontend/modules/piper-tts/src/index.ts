// piper-tts: JavaScript bridge for the local native module.
// Provides exactly the same surface (NativeModules.TTSManager) that the old
// react-native-sherpa-onnx-offline-tts patch exposed, so piperEngine.ts can
// migrate with a one-line require() change.
import { NativeModules } from 'react-native';

const { TTSManager } = NativeModules as {
  TTSManager?: {
    // Voice management
    listVoices: () => Promise<VoiceInfo[]>;
    loadVoice: (voiceId: string) => Promise<{ sampleRate: number; lengthScale: number; noiseScale: number; noiseW: number; }>;
    unloadVoice: () => Promise<void>;
    // Synthesis & playback
    generateAndPlay: (text: string, _sid: number, speed: number) => Promise<void>;
    stopPlayback: () => Promise<void>;
    // Legacy compatibility shims
    initializeTTS?: (sampleRate: number, channels: number, configJson: string) => Promise<string>;
    deinitialize?: () => Promise<void>;
    // MediaSession / foreground service
    startPlaybackSession: (info: { title: string; author?: string | null; coverBase64?: string | null; isPlaying?: boolean }) => Promise<void>;
    updatePlaybackSession: (info: { title?: string; author?: string | null; coverBase64?: string | null; isPlaying?: boolean }) => Promise<void>;
    stopPlaybackSession: () => Promise<void>;
  };
};

export type VoiceInfo = {
  id: string;
  name: string;
  language: string;
  quality: string;
  sampleRate: number;
  numSpeakers: number;
  espeakVoice: string;
  sizeBytes: number;
};

export function isPiperAvailable(): boolean {
  return !!TTSManager && typeof TTSManager.loadVoice === 'function';
}

export function getPiperNative() {
  return TTSManager || null;
}

export default TTSManager;
