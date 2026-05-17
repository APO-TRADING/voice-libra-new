// On-device Piper TTS engine \u2014 fully offline, no server.
//
// Architecture:
//   JS (this file) \u2192 NativeModules.TTSManager \u2192 Kotlin (piper-tts module)
//                                              \u2192 onnxruntime-android (Microsoft, Maven)
//                                              \u2192 espeak-ng (compiled from source via NDK)
//                                              \u2192 AudioTrack PCM player
//
// Replaces the previous sherpa-onnx based implementation. Public API is
// unchanged so PlayerContext.tsx and Settings can keep their existing
// integration: initEngine / speakSentence / stopSpeak / progress callbacks
// keep working as before.
//
// What's new:
//   \u2022 listVoices() / getCurrentVoiceId() / setCurrentVoiceId() / reloadEngine()
//   \u2022 Multiple Piper models bundled in the APK, selectable from Settings
//   \u2022 Each voice has its own .onnx + .onnx.json sidecar \u2014 NO metadata
//     injection: native code reads phoneme_id_map directly from the JSON.
//   \u2022 FP16 / INT8 quantized models supported natively by ONNX Runtime.
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
let initPromise: Promise<boolean> | null = null;
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
  return { ready, lastError, lastStep, available: isPiperAvailable(), voiceId: loadedVoiceId, sampleRate: currentSampleRate };
}

// ----- Trace logger (persistent across crashes) -----
async function trace(step: string, info: string = ''): Promise<void> {
  lastStep = step;
  const line = `[${new Date().toISOString()}] [js] ${step}${info ? ' :: ' + info : ''}\n`;
  try {
    const existing = (await FileSystem.getInfoAsync(TRACE_FILE)).exists
      ? await FileSystem.readAsStringAsync(TRACE_FILE)
      : '';
    const truncated = existing.length > 100_000 ? existing.slice(-50_000) : existing;
    await FileSystem.writeAsStringAsync(TRACE_FILE, truncated + line);
  } catch { /* ignore */ }
  console.log(`[Piper trace] ${line.trim()}`);
}

export async function readPiperTrace(): Promise<string> {
  try {
    const info = await FileSystem.getInfoAsync(TRACE_FILE);
    if (!info.exists) return '(nessun trace registrato)';
    return await FileSystem.readAsStringAsync(TRACE_FILE);
  } catch (e: any) {
    return `(impossibile leggere trace: ${e?.message || e})`;
  }
}

export async function clearPiperTrace(): Promise<void> {
  try { await FileSystem.deleteAsync(TRACE_FILE, { idempotent: true }); } catch { /* ignore */ }
}

// ----- Voice catalog (no native call needed) -----
export function listVoices(): VoiceMeta[] {
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
  // Force the engine to reload on next play()
  ready = false;
  loadedVoiceId = null;
  initPromise = null;
  await trace('voice.set', `id=${voiceId}`);
}

export function getCurrentVoiceMeta(): VoiceMeta | null {
  return currentVoiceMeta;
}

// ----- System info logging -----
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
    await trace('sysinfo.expo',
      `expo=${Constants.expoConfig?.version || '?'} sdk=${Constants.expoConfig?.sdkVersion || '?'}`);
  } catch (e: any) {
    await trace('sysinfo.err', `${e?.message || e}`);
  }
}

// ----- Asset extraction helpers -----
async function ensureDir(path: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

function stripFilePrefix(p: string): string {
  return p.startsWith('file://') ? p.slice(7) : p;
}

async function copyVoiceAsset(modId: number, destPath: string, label: string): Promise<string> {
  const info = await FileSystem.getInfoAsync(destPath);
  if (info.exists) {
    await trace(`copy.${label}.skip`, 'already exists');
    return destPath;
  }
  await trace(`copy.${label}.resolve`, '');
  const asset = Asset.fromModule(modId);
  await asset.downloadAsync();
  const src = asset.localUri || asset.uri;
  if (!src) throw new Error(`Asset ${label} has empty localUri`);
  await trace(`copy.${label}.copy`, `${src.slice(0, 100)} -> ${destPath.slice(0, 100)}`);
  // Make sure parent dir exists
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

// ----- Main init -----
export async function initEngine(): Promise<boolean> {
  if (initPromise && ready) return initPromise;
  if (initPromise && !ready) {
    // Previous init failed or is in progress; await it once before deciding.
    try { const r = await initPromise; if (r) return true; } catch { /* fall through */ }
  }

  // Determine target voice
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

  initPromise = (async () => {
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
    await trace('init.native', 'OK');

    try {
      await ensureDir(VOICES_DIR);

      // 1. Extract espeak-ng-data
      emitProgress('Estrazione dizionari fonetici...', 10);
      await trace('==PHASE.1==', 'unzip espeak-ng-data');
      const dataDir = await unzipEspeakData();

      // 2. Copy the chosen voice's model.onnx + write its JSON sidecar
      emitProgress(`Caricamento voce "${voiceMeta.name}"...`, 40, `${voiceMeta.size_mb || '?'} MB`);
      const voiceDir = `${VOICES_DIR}/${voiceId}`;
      await ensureDir(voiceDir);
      const modelPath = `${voiceDir}/model.onnx`;
      await trace('==PHASE.2==', `copy model -> ${modelPath}`);
      await copyVoiceAsset(voiceAsset.model, modelPath, `${voiceId}.onnx`);
      const modelStat = await FileSystem.getInfoAsync(modelPath, { size: true } as any);
      await trace('phase2.done', `size=${(modelStat as any).size || 0}B`);

      const configJson = JSON.stringify(voiceAsset.config);

      // 3. Native loadVoice
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
        `sr=${result.sampleRate} lang=${result.languageCode} (${result.languageName}) ` +
        `phonemes=${result.numSymbols} speakers=${result.numSpeakers}`);
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
  })();
  return initPromise;
}

/** Force reload (after voice change). */
export async function reloadEngine(): Promise<boolean> {
  try {
    const native = getPiperNative();
    if (native) await native.unloadVoice().catch(() => {});
  } catch { /* ignore */ }
  ready = false;
  loadedVoiceId = null;
  initPromise = null;
  return initEngine();
}

export function isPiperReady(): boolean {
  return ready;
}

// ----- Speech API (unchanged signatures) -----
function sanitizeForPiper(raw: string): string {
  return raw
    .replace(/(\p{L})-(\p{L})/gu, '$1 $2')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function speakSentence(text: string, lengthScale: number): Promise<void> {
  const native = getPiperNative();
  if (!native || !ready) {
    await trace('speak.skip', 'engine not ready');
    throw new Error('Piper not available');
  }
  const speed = Math.max(0.5, Math.min(2.0, 1 / lengthScale));
  const clean = sanitizeForPiper(text);
  if (!clean) {
    await trace('speak.skip', 'empty after sanitize');
    return;
  }
  try {
    await trace('speak.start', `len=${clean.length} speed=${speed.toFixed(2)}`);
    await native.generateAndPlay(clean, 0, speed);
    await trace('speak.end', 'OK');
  } catch (e: any) {
    await trace('speak.error', `${e?.message || String(e)}`);
    throw e;
  }
}

export async function stopSpeak(): Promise<void> {
  const native = getPiperNative();
  if (!native) return;
  try {
    await trace('stop.call', 'stopPlayback');
    await native.stopPlayback();
    await trace('stop.call', 'OK');
  } catch (e: any) {
    await trace('stop.call.err', `${e?.message || e}`);
  }
}

// ----- MediaSession wrappers (unchanged signatures) -----
export type PlaybackSession = {
  title: string;
  author?: string | null;
  coverBase64?: string | null;
  isPlaying: boolean;
};

export async function startPlaybackSession(s: PlaybackSession): Promise<void> {
  const native = getPiperNative();
  if (!native || typeof native.startPlaybackSession !== 'function') return;
  try {
    await native.startPlaybackSession({
      title: s.title || 'Audiobook',
      author: s.author || '',
      coverBase64: s.coverBase64 || null,
      isPlaying: !!s.isPlaying,
    });
  } catch (e: any) {
    await trace('session.start.err', `${e?.message || e}`);
  }
}

export async function updatePlaybackSession(s: Partial<PlaybackSession>): Promise<void> {
  const native = getPiperNative();
  if (!native || typeof native.updatePlaybackSession !== 'function') return;
  try {
    await native.updatePlaybackSession({
      title: s.title ?? 'Audiobook',
      author: s.author ?? '',
      coverBase64: s.coverBase64 ?? null,
      isPlaying: typeof s.isPlaying === 'boolean' ? s.isPlaying : true,
    });
  } catch (e: any) {
    await trace('session.update.err', `${e?.message || e}`);
  }
}

export async function stopPlaybackSession(): Promise<void> {
  const native = getPiperNative();
  if (!native || typeof native.stopPlaybackSession !== 'function') return;
  try {
    await native.stopPlaybackSession();
  } catch (e: any) {
    await trace('session.stop.err', `${e?.message || e}`);
  }
}

// ----- Diagnostics (used by Settings screen) -----
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
      `${meta.name} \u2014 ${meta.language} ${meta.quality} (~${meta.size_mb}MB)`);
  }

  await push('EngineState', true,
    `ready=${ready} loaded=${loadedVoiceId || 'none'} lastError=${lastError || 'none'}`);
  return results;
}

// ----- Legacy error decoder (kept for Settings UI compat) -----
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
      detail: 'Il file model.onnx non \u00e8 un ONNX valido.',
      suggestion: 'Verifica che il modello sia stato copiato correttamente in assets/piper/voices/.',
      category: 'file_corrupt',
    };
  }
  if (/out of memory|OOM|allocation failed/i.test(msg)) {
    return {
      title: 'Memoria insufficiente',
      detail: 'Il dispositivo non ha abbastanza RAM per caricare il modello.',
      suggestion: 'Chiudi altre app o usa una voce pi\u00f9 piccola (x_low).',
      category: 'out_of_memory',
    };
  }
  return {
    title: 'Errore TTS sconosciuto',
    detail: msg.length > 200 ? msg.slice(0, 200) + '\u2026' : msg,
    suggestion: 'Copia il trace dalla diagnostica e segnalalo.',
    category: 'unknown',
  };
}

export const piperPlatformOk = Platform.OS === 'android' || Platform.OS === 'ios';
