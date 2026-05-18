// On-device Piper TTS engine — fully offline, no server.
//
// Architecture:
//   JS (this file) → NativeModules.TTSManager → Kotlin (piper-tts module)
//                                              → onnxruntime-android (Microsoft, Maven)
//                                              → ItalianPhonemizer (Kotlin) OR espeak-ng (NDK)
//                                              → AudioTrack PCM player
//
// FEATURES:
//   • Persistent trace logger that survives app restarts (saved to
//     FileSystem.documentDirectory/piper-trace.log). Captures every
//     lifecycle event from module load → engine init → playback.
//   • Global JS error handler that copies unhandled errors into the
//     trace, so the user can read what failed after a crash.
//   • Mutex on initEngine() so concurrent callers don't double-init.
//   • Serialized trace writes so concurrent log lines never corrupt
//     the trace file.
//   • Voice manager: list/get/set the bundled voice. Each voice has
//     its own .onnx + .onnx.json read directly (no metadata injection).
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Asset } from 'expo-asset';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as FileSystem from 'expo-file-system/legacy';
import { unzipSync } from 'fflate';
import { Buffer } from 'buffer';
import { NativeModules, Platform } from 'react-native';
import {
  DEFAULT_VOICE_ID,
  ESPEAK_DATA_ZIP,
  PIPER_VOICES,
  VOICES_MANIFEST,
  type VoiceMeta,
} from './piperAssets';
import { getPiperNative, isPiperAvailable } from './piperBridge';

const VOICES_DIR = `${FileSystem.documentDirectory}piper/voices`;
const ESPEAK_DIR = `${FileSystem.documentDirectory}piper/espeak-ng-data`;
const TRACE_FILE = `${FileSystem.documentDirectory}piper-trace.log`;
const ASYNC_VOICE_KEY = '@piper/selected_voice_v2';

// ----- State -----
let currentVoiceId: string = DEFAULT_VOICE_ID;
let currentVoiceMeta: VoiceMeta | null = null;
let loadedVoiceId: string | null = null;
let initInFlight: Promise<boolean> | null = null;
let ready = false;
let lastError: string | null = null;
let lastStep: string = 'idle';
let currentSampleRate = 22050;

// ----- Public types kept identical to the previous engine for compat -----
export type ProgressInfo = { step: string; percent: number; detail?: string };
type ProgressCallback = (info: ProgressInfo | null) => void;
let progressListener: ProgressCallback | null = null;

export function setPiperProgressListener(cb: ProgressCallback | null): void {
  progressListener = cb;
}

function emitProgress(step: string, percent: number, detail?: string): void {
  try { progressListener?.({ step, percent, detail }); } catch { /* never crash */ }
}

export function getPiperDiagnostics() {
  return {
    ready,
    lastError,
    lastStep,
    available: isPiperAvailable(),
    voiceId: loadedVoiceId,
    sampleRate: currentSampleRate,
  };
}

// =========================================================================
// PERSISTENT TRACE LOGGER
// =========================================================================
//
// Each call to trace() appends a timestamped line to /piper-trace.log.
// Writes are queued through a single Promise chain so concurrent callers
// never overlap (the read-modify-write cycle would otherwise lose lines).
// File is auto-truncated to ~100KB to avoid unbounded growth.

let _traceQueue: Promise<void> = Promise.resolve();

function fmtNow(): string {
  // Compact local-time format that's still ISO-parseable:
  // "2026-02-15T18:24:01.234Z" -> "26-02-15 18:24:01.234"
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getFullYear() % 100)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function trace(step: string, info: string = ''): Promise<void> {
  lastStep = step;
  const line = `[${fmtNow()}] ${step}${info ? ' :: ' + info : ''}\n`;
  // Mirror to console so Android Logcat shows it too (useful during dev).
  // eslint-disable-next-line no-console
  console.log(`[Piper] ${line.trim()}`);
  _traceQueue = _traceQueue.then(async () => {
    try {
      const info_ = await FileSystem.getInfoAsync(TRACE_FILE);
      const existing = info_.exists ? await FileSystem.readAsStringAsync(TRACE_FILE) : '';
      const truncated = existing.length > 100_000 ? existing.slice(-50_000) : existing;
      await FileSystem.writeAsStringAsync(TRACE_FILE, truncated + line);
    } catch {
      /* ignore IO errors — we still printed to console */
    }
  });
  return _traceQueue;
}

export async function readPiperTrace(): Promise<string> {
  try {
    // Make sure any pending writes are flushed before reading.
    await _traceQueue;
    const info_ = await FileSystem.getInfoAsync(TRACE_FILE);
    if (!info_.exists) return '(nessun trace registrato)';
    return await FileSystem.readAsStringAsync(TRACE_FILE);
  } catch (e: any) {
    return `(impossibile leggere trace: ${e?.message || e})`;
  }
}

export async function clearPiperTrace(): Promise<void> {
  try {
    await _traceQueue;
    await FileSystem.deleteAsync(TRACE_FILE, { idempotent: true });
  } catch { /* ignore */ }
}

// =========================================================================
// GLOBAL ERROR HANDLER
// =========================================================================
//
// React Native exposes `ErrorUtils.setGlobalHandler` for uncaught JS errors
// and `process.on('unhandledRejection', ...)` for promise rejections.
// We chain into both so any unexpected error ends up in the trace file.

function installGlobalErrorHandler(): void {
  const globalAny = globalThis as any;
  if (globalAny.__piperErrorHandlerInstalled) return;
  globalAny.__piperErrorHandlerInstalled = true;
  try {
    const eu = globalAny.ErrorUtils;
    if (eu && typeof eu.getGlobalHandler === 'function') {
      const prev = eu.getGlobalHandler();
      eu.setGlobalHandler((err: Error, isFatal: boolean) => {
        const msg = `fatal=${isFatal} name=${err?.name || '?'} ${err?.message || err}`;
        const stack = err?.stack ? '\n' + err.stack.split('\n').slice(0, 8).join('\n') : '';
        trace('GLOBAL_ERROR', msg + stack);
        try { prev?.(err, isFatal); } catch { /* ignore */ }
      });
      trace('errorHandler.installed', 'ErrorUtils.setGlobalHandler hooked');
    }
  } catch (e: any) {
    trace('errorHandler.err', String(e?.message || e));
  }
  // Hermes unhandled-promise hook (RN >= 0.69 / Hermes 0.12+)
  try {
    const hermes = globalAny.HermesInternal;
    if (hermes?.enablePromiseRejectionTracker) {
      hermes.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: (id: any, err: Error) => {
          trace('UNHANDLED_PROMISE', `id=${id} ${err?.message || err}`);
        },
        onHandled: () => { /* noop */ },
      });
      trace('errorHandler.installed', 'HermesPromiseRejectionTracker hooked');
    }
  } catch (e: any) {
    trace('errorHandler.hermes.err', String(e?.message || e));
  }
}

// =========================================================================
// MODULE LOAD — fire as soon as piperEngine.ts is imported.
// =========================================================================

(function bootstrap() {
  try {
    installGlobalErrorHandler();
  } catch { /* ignore */ }
  trace('==SESSION.START==',
    `app=${Constants.expoConfig?.version || '?'} ` +
    `os=${Platform.OS}/${Platform.Version} ` +
    `hermes=${!!(globalThis as any).HermesInternal}`);
})();

/** Public helper: lets other modules add their own lifecycle traces. */
export function tracePiper(step: string, info: string = ''): void {
  // Fire-and-forget; we don't await from callers.
  trace(step, info).catch(() => {});
}

// =========================================================================
// VOICE CATALOG
// =========================================================================

export function listVoices(): VoiceMeta[] {
  // Only return voices whose assets are actually bundled.
  return VOICES_MANIFEST.voices.filter((v) => !!PIPER_VOICES[v.id]);
}

export async function getCurrentVoiceId(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(ASYNC_VOICE_KEY);
    if (stored && PIPER_VOICES[stored]) {
      currentVoiceId = stored;
    }
  } catch { /* ignore */ }
  return currentVoiceId;
}

export async function setCurrentVoiceId(voiceId: string): Promise<void> {
  if (!PIPER_VOICES[voiceId]) {
    throw new Error(`Voice "${voiceId}" not found in PIPER_VOICES map`);
  }
  await AsyncStorage.setItem(ASYNC_VOICE_KEY, voiceId);
  currentVoiceId = voiceId;
  // Force the engine to reload on next play().
  ready = false;
  loadedVoiceId = null;
  initInFlight = null;
  await trace('voice.set', `id=${voiceId}`);
}

export function getCurrentVoiceMeta(): VoiceMeta | null {
  return currentVoiceMeta;
}

// =========================================================================
// SYSTEM INFO LOGGING
// =========================================================================

async function logSystemInfo(): Promise<void> {
  try {
    const brand = Device.brand || 'unknown';
    const modelName = Device.modelName || 'unknown';
    const osName = Device.osName || Platform.OS;
    const osVersion = Device.osVersion || 'unknown';
    const totalMemMB = Math.round((Device.totalMemory || 0) / (1024 * 1024));
    const arch = (Device as any).supportedCpuArchitectures?.join(',') || 'unknown';
    await trace('sysinfo',
      `${brand} ${modelName} os=${osName}/${osVersion} mem=${totalMemMB}MB arch=${arch}`);
  } catch (e: any) {
    await trace('sysinfo.err', `${e?.message || e}`);
  }
}

// =========================================================================
// ASSET EXTRACTION HELPERS
// =========================================================================

async function ensureDir(path: string): Promise<void> {
  const info_ = await FileSystem.getInfoAsync(path);
  if (!info_.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

function stripFilePrefix(p: string): string {
  return p.startsWith('file://') ? p.slice(7) : p;
}

async function copyVoiceAsset(modId: number, destPath: string, label: string): Promise<string> {
  const info_ = await FileSystem.getInfoAsync(destPath);
  if (info_.exists) {
    await trace(`copy.${label}.skip`, 'already exists');
    return destPath;
  }
  await trace(`copy.${label}.resolve`, '');
  const asset = Asset.fromModule(modId);
  await asset.downloadAsync();
  const src = asset.localUri || asset.uri;
  if (!src) throw new Error(`Asset ${label} has empty localUri`);
  await trace(`copy.${label}.copy`, `${src.slice(0, 100)} -> ${destPath.slice(0, 100)}`);
  const parent = destPath.replace(/\/[^/]+$/, '');
  await ensureDir(parent);
  await FileSystem.copyAsync({ from: src, to: destPath });
  await trace(`copy.${label}.ok`, '');
  return destPath;
}

async function countDirEntries(dirPath: string): Promise<number> {
  try {
    const entries = await FileSystem.readDirectoryAsync(dirPath);
    return entries.length;
  } catch { return -1; }
}

async function unzipEspeakData(): Promise<string> {
  const marker = `${ESPEAK_DIR}/.ready`;
  const dirInfo = await FileSystem.getInfoAsync(ESPEAK_DIR);
  const markerInfo = await FileSystem.getInfoAsync(marker);
  if (dirInfo.exists && dirInfo.isDirectory && markerInfo.exists) {
    const n = await countDirEntries(ESPEAK_DIR);
    await trace('espeak.skip', `already extracted, entries=${n}`);
    return ESPEAK_DIR;
  }
  if (dirInfo.exists) {
    await trace('espeak.cleanup', 'partial dir, deleting');
    try { await FileSystem.deleteAsync(ESPEAK_DIR, { idempotent: true }); } catch { /* ignore */ }
  }
  await ensureDir(ESPEAK_DIR);

  await trace('espeak.resolve', '');
  const asset = Asset.fromModule(ESPEAK_DATA_ZIP);
  await asset.downloadAsync();
  const src = asset.localUri || asset.uri;
  if (!src) throw new Error('espeak-ng-data.bin: empty localUri');

  await trace('espeak.read', 'base64');
  const b64 = await FileSystem.readAsStringAsync(src, { encoding: FileSystem.EncodingType.Base64 });
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  await trace('espeak.decode', `size=${bytes.length}B`);

  const entries = unzipSync(bytes);
  const totalEntries = Object.keys(entries).length;
  await trace('espeak.unzip', `${totalEntries} entries`);

  let count = 0;
  for (const [name, data] of Object.entries(entries)) {
    const fullPath = `${ESPEAK_DIR}/${name}`;
    if (name.endsWith('/') || data.length === 0) {
      await ensureDir(fullPath);
      continue;
    }
    const parent = fullPath.replace(/\/[^/]+$/, '');
    await ensureDir(parent);
    const out64 = Buffer.from(data).toString('base64');
    await FileSystem.writeAsStringAsync(fullPath, out64, { encoding: FileSystem.EncodingType.Base64 });
    count += 1;
    if (count % 50 === 0) {
      await trace('espeak.write', `${count}/${totalEntries}`);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  await FileSystem.writeAsStringAsync(marker, String(count), { encoding: FileSystem.EncodingType.UTF8 });
  await trace('espeak.complete', `wrote ${count} files`);
  return ESPEAK_DIR;
}

// =========================================================================
// MAIN INIT (with mutex)
// =========================================================================

async function doInitEngine(): Promise<boolean> {
  await getCurrentVoiceId();
  const voiceId = currentVoiceId;
  const voiceMeta = VOICES_MANIFEST.voices.find((v) => v.id === voiceId);
  const voiceAsset = PIPER_VOICES[voiceId];
  if (!voiceMeta || !voiceAsset) {
    lastError = `Unknown voice id: ${voiceId}`;
    await trace('init.bad-voice', lastError);
    return false;
  }
  currentVoiceMeta = voiceMeta;

  await trace('==INIT.START==', `voice=${voiceId} (${voiceMeta.name} / ${voiceMeta.language})`);
  emitProgress('Avvio motore TTS...', 1);
  await logSystemInfo();

  const native = getPiperNative();
  if (!isPiperAvailable() || !native) {
    lastError = 'Modulo nativo non disponibile (anteprima Expo Go)';
    await trace('init.no-native', lastError);
    emitProgress('Modulo nativo non disponibile', 0, lastError);
    return false;
  }
  await trace('init.native', 'OK - NativeModules.TTSManager present');

  try {
    await ensureDir(VOICES_DIR);

    emitProgress('Estrazione dizionari fonetici...', 10);
    await trace('==PHASE.1==', 'unzip espeak-ng-data');
    const dataDir = await unzipEspeakData();

    emitProgress(`Caricamento voce "${voiceMeta.name}"...`, 40, `${voiceMeta.size_mb || '?'} MB`);
    const voiceDir = `${VOICES_DIR}/${voiceId}`;
    await ensureDir(voiceDir);
    const modelPath = `${voiceDir}/model.onnx`;
    await trace('==PHASE.2==', `copy model -> ${modelPath}`);
    await copyVoiceAsset(voiceAsset.model, modelPath, `${voiceId}.onnx`);
    const modelStat: any = await FileSystem.getInfoAsync(modelPath, { size: true } as any);
    await trace('phase2.done', `size=${modelStat?.size || 0}B`);

    const configJson = JSON.stringify(voiceAsset.config);
    await trace('phase2.config', `len=${configJson.length}B keys=${Object.keys(voiceAsset.config).join(',')}`);

    emitProgress('Inizializzazione motore ONNX...', 70, 'Microsoft ONNX Runtime');
    await trace('==PHASE.3==', 'native.loadVoice');
    const result = await native.loadVoice(
      stripFilePrefix(modelPath),
      configJson,
      stripFilePrefix(dataDir),
    );
    currentSampleRate = result.sampleRate;
    loadedVoiceId = voiceId;
    ready = true;
    lastError = null;
    await trace('==INIT.READY==',
      `sr=${result.sampleRate} lang=${result.languageCode}/${result.languageName} ` +
      `phonemes=${result.numSymbols} speakers=${result.numSpeakers} ` +
      `espeak=${result.espeakVoice} ` +
      `nativePhonemizer=${(result as any).nativePhonemizer ?? 'unknown'}`);
    emitProgress('Voce pronta!', 100);
    setTimeout(() => emitProgress('', 0), 1500);
    return true;
  } catch (e: any) {
    ready = false;
    loadedVoiceId = null;
    lastError = `${lastStep}: ${e?.message || String(e)}`;
    await trace('==INIT.ERROR==', `at step=${lastStep}: ${e?.message || String(e)}`);
    emitProgress('Errore caricamento', 0, e?.message || String(e));
    return false;
  }
}

export async function initEngine(): Promise<boolean> {
  if (ready) return true;
  // Mutex: if another init is in flight, just wait for it.
  if (initInFlight) {
    await trace('init.coalesce', 'reusing in-flight init promise');
    return initInFlight;
  }
  initInFlight = (async () => {
    try {
      return await doInitEngine();
    } finally {
      // Allow re-init on next call if this one failed.
      initInFlight = null;
    }
  })();
  return initInFlight;
}

export async function reloadEngine(): Promise<boolean> {
  await trace('reload.begin', `current=${loadedVoiceId || 'none'} target=${currentVoiceId}`);
  try {
    const native = getPiperNative();
    if (native) await native.unloadVoice().catch(() => {});
  } catch { /* ignore */ }
  ready = false;
  loadedVoiceId = null;
  initInFlight = null;
  return initEngine();
}

export function isPiperReady(): boolean {
  return ready;
}

// =========================================================================
// SPEECH API (expo-audio-backed)
// =========================================================================

import {
  playWav,
  pausePlayback,
  resumePlayback,
  stopPlayback,
  type SentenceMetadata,
} from './audiobookPlayer';

function sanitizeForPiper(raw: string): string {
  return raw
    .replace(/(\p{L})-(\p{L})/gu, '$1 $2')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Synthesize ONE sentence and play it via expo-audio.
 *
 * Resolves when the clip finishes playing naturally (didJustFinish event)
 * or when the audio is hard-stopped via stopSpeak(). On pause-from-
 * lockscreen the underlying expo-audio player just pauses; resume
 * continues the same clip to completion. The Promise stays unresolved
 * the whole time the audio is paused, which is what we want — the
 * playLoop in PlayerContext waits on us, and won't auto-advance.
 *
 * @param text         the raw sentence text to read
 * @param lengthScale  Piper length_scale; speed = 1 / lengthScale
 * @param meta         optional override for lockscreen title/artist/album
 */
export async function speakSentence(
  text: string,
  lengthScale: number,
  meta?: Partial<SentenceMetadata>,
): Promise<void> {
  const native = getPiperNative();
  if (!native || !ready) {
    await trace('speak.skip', `ready=${ready} native=${!!native}`);
    throw new Error('Piper not available');
  }
  const speed = Math.max(0.5, Math.min(2.0, 1 / lengthScale));
  const clean = sanitizeForPiper(text);
  if (!clean) {
    await trace('speak.skip', 'empty after sanitize');
    return;
  }
  let wavPath: string | null = null;
  try {
    await trace('speak.synth', `len=${clean.length} speed=${speed.toFixed(2)}`);
    // 1. Synthesize to WAV on disk.
    const result = await native.synthesizeToFile(clean, 0, speed);
    wavPath = result.path;
    await trace('speak.wav', `${result.path.split('/').pop()} ${Math.round(result.durationMs)}ms (synth=${Math.round(result.synthMs)}ms)`);

    // 2. Hand off to expo-audio. playWav() resolves when the clip ends
    //    naturally (didJustFinish) or when stopPlayback() is called.
    const sentenceMeta: SentenceMetadata = {
      bookTitle: meta?.bookTitle || 'Audiobook',
      bookAuthor: meta?.bookAuthor || 'Beppe Audiobooks',
      voiceName: meta?.voiceName || currentVoiceMeta?.name || currentVoiceId,
      coverUrl: meta?.coverUrl || null,
    };

    // Safety race: if neither finish nor stop fires within 5x expected
    // duration, bail out so the caller's loop never hangs.
    const safetyMs = Math.max(15_000, result.durationMs * 5);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const safety = new Promise<void>((_, reject) => {
      timeoutId = setTimeout(() => {
        trace('speak.timeout', `${safetyMs}ms elapsed without finish/stop event`).catch(() => {});
        reject(new Error(`Playback timeout after ${safetyMs}ms`));
      }, safetyMs);
    });

    try {
      await Promise.race([playWav(wavPath, sentenceMeta), safety]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    // Clean up the WAV file — we don't need it anymore.
    if (wavPath) native.deleteWavFile(wavPath).catch(() => {});

    await trace('speak.end', 'OK');
  } catch (e: any) {
    await trace('speak.error', `${e?.message || String(e)}`);
    if (wavPath) native.deleteWavFile(wavPath).catch(() => {});
    throw e;
  }
}

/** Hard stop — cancels in-flight synthesis AND tears down the audio session. */
export async function stopSpeak(): Promise<void> {
  const native = getPiperNative();
  try {
    await trace('stop.call', 'native.stopPlayback + expo-audio.stop');
    if (native) await native.stopPlayback().catch(() => {});
    await stopPlayback();
    if (native) await native.cleanupWavCache().catch(() => {});
    await trace('stop.call', 'OK');
  } catch (e: any) {
    await trace('stop.call.err', `${e?.message || e}`);
  }
}

/** Soft pause via expo-audio — keeps current sentence loaded so resume continues. */
export async function pauseSpeak(): Promise<void> {
  try {
    await trace('pause.call', 'expo-audio.pause');
    await pausePlayback();
  } catch (e: any) {
    await trace('pause.call.err', `${e?.message || e}`);
  }
}

/** Soft resume via expo-audio — continues the current sentence from where it was. */
export async function resumeSpeak(): Promise<void> {
  try {
    await trace('resume.call', 'expo-audio.resume');
    await resumePlayback();
  } catch (e: any) {
    await trace('resume.call.err', `${e?.message || e}`);
  }
}

// =========================================================================
// DIAGNOSTICS (used by Settings screen)
// =========================================================================

export type DiagnosticItem = { name: string; ok: boolean; detail: string };

export async function runFullDiagnostics(): Promise<DiagnosticItem[]> {
  const results: DiagnosticItem[] = [];
  const push = async (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    await trace(`diag.${name}`, `ok=${ok} ${detail}`);
  };
  await trace('==DIAGNOSTICS==', 'start');

  await push('Platform',
    Platform.OS === 'android' || Platform.OS === 'ios',
    `OS=${Platform.OS} ver=${Platform.Version}`);
  await push('Device', !!Device.brand,
    `${Device.brand || '?'} ${Device.modelName || '?'} mem=${Math.round((Device.totalMemory || 0) / (1024 * 1024))}MB`);

  const native: any = (NativeModules as any).TTSManager;
  await push('NativeModule',
    !!native && typeof native.loadVoice === 'function',
    `TTSManager=${!!native} hasLoad=${typeof native?.loadVoice}`);

  const voiceId = await getCurrentVoiceId();
  await push('CurrentVoice', !!PIPER_VOICES[voiceId], `id=${voiceId}`);

  for (const meta of listVoices()) {
    const has = !!PIPER_VOICES[meta.id];
    await push(`Voice:${meta.id}`, has,
      `${meta.name} — ${meta.language} ${meta.quality} (~${meta.size_mb}MB)`);
  }

  await push('EngineState', true,
    `ready=${ready} loaded=${loadedVoiceId || 'none'} lastError=${lastError || 'none'}`);
  return results;
}

// =========================================================================
// ERROR DECODER (used by Settings)
// =========================================================================

export type DecodedError = {
  title: string; detail: string; suggestion: string;
  category: 'fp16_mismatch' | 'quantized' | 'missing_op' | 'opset_too_new' | 'file_corrupt' | 'out_of_memory' | 'native_missing' | 'unknown';
};

export function decodePiperError(raw: string | null | undefined): DecodedError | null {
  if (!raw) return null;
  const msg = String(raw);
  if (/Native.*not available|TTSManager.*missing|Modulo nativo/i.test(msg)) {
    return {
      title: 'Modulo nativo mancante',
      detail: 'Stai usando Expo Go o un build di sviluppo senza il modulo Piper compilato.',
      suggestion: 'Crea un build EAS: eas build --platform android --profile preview',
      category: 'native_missing',
    };
  }
  if (/Protobuf|invalid model|corrupted|truncated/i.test(msg)) {
    return {
      title: 'File modello corrotto',
      detail: 'Il file model.onnx non è un ONNX valido.',
      suggestion: 'Verifica che il modello sia stato copiato correttamente in assets/piper/voices/.',
      category: 'file_corrupt',
    };
  }
  if (/out of memory|OOM|allocation failed/i.test(msg)) {
    return {
      title: 'Memoria insufficiente',
      detail: 'Il dispositivo non ha abbastanza RAM per caricare il modello.',
      suggestion: 'Chiudi altre app o usa una voce più piccola (x_low).',
      category: 'out_of_memory',
    };
  }
  return {
    title: 'Errore TTS sconosciuto',
    detail: msg.length > 200 ? msg.slice(0, 200) + '…' : msg,
    suggestion: 'Copia il trace dalla diagnostica e segnalalo.',
    category: 'unknown',
  };
}

export const piperPlatformOk = Platform.OS === 'android' || Platform.OS === 'ios';
