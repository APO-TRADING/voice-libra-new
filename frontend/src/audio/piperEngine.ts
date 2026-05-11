// On-device Piper TTS engine using react-native-sherpa-onnx-offline-tts.
// Real-time, offline, no server. Assets are pre-bundled in the APK.
//
// The bundled beppe.onnx MUST be the version produced by
// scripts/prepare_piper_model.py — i.e., a Piper .onnx with sherpa-onnx
// metadata injected (model_type=vits, comment=piper, has_espeak=1, ...).
// Without those metadata sherpa-onnx will refuse to load the model.
//
// At first launch:
//   1) Copy beppe.onnx + tokens.txt to documents/piper/
//   2) Unzip espeak-ng-data.bin → documents/piper/espeak-ng-data/
//   3) Init sherpa-onnx with full OfflineTtsConfig
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { unzipSync } from 'fflate';
import { Platform } from 'react-native';
import { PIPER_ASSETS } from './piperAssets';
import { getSherpaTTS, isPiperAvailable } from './sherpaPiper';

let initPromise: Promise<boolean> | null = null;
let ready = false;
let lastError: string | null = null;
let lastStep: string = 'idle';

const DEST_DIR = `${FileSystem.documentDirectory}piper`;

export function getPiperDiagnostics() {
  return { ready, lastError, lastStep, available: isPiperAvailable() };
}

async function ensureDir(path: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

async function copyAsset(modId: number, destName: string): Promise<string> {
  const dest = `${DEST_DIR}/${destName}`;
  const info = await FileSystem.getInfoAsync(dest);
  if (info.exists) return dest;
  const asset = Asset.fromModule(modId);
  await asset.downloadAsync();
  const src = asset.localUri || asset.uri;
  if (!src) throw new Error(`Asset ${destName} ha localUri vuoto`);
  await FileSystem.copyAsync({ from: src, to: dest });
  return dest;
}

async function unzipEspeak(modId: number): Promise<string> {
  const dataDir = `${DEST_DIR}/espeak-ng-data`;
  const marker = `${DEST_DIR}/.espeak-ready`;

  // Only trust the dir if the completion marker exists (avoids partial state
  // from a previous app crash during unzip).
  const dirInfo = await FileSystem.getInfoAsync(dataDir);
  const markerInfo = await FileSystem.getInfoAsync(marker);
  if (dirInfo.exists && dirInfo.isDirectory && markerInfo.exists) {
    return dataDir;
  }
  // Clean up any partial extraction.
  if (dirInfo.exists) {
    try { await FileSystem.deleteAsync(dataDir, { idempotent: true }); } catch { /* ignore */ }
  }

  const asset = Asset.fromModule(modId);
  await asset.downloadAsync();
  const src = asset.localUri || asset.uri;
  if (!src) throw new Error('espeak-ng-data.bin: localUri vuoto');
  const b64 = await FileSystem.readAsStringAsync(src, { encoding: FileSystem.EncodingType.Base64 });
  const bin = globalThis.atob ? globalThis.atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const entries = unzipSync(bytes);

  let count = 0;
  for (const [name, data] of Object.entries(entries)) {
    const fullPath = `${DEST_DIR}/${name}`;
    if (name.endsWith('/') || data.length === 0) {
      await ensureDir(fullPath);
      continue;
    }
    const parent = fullPath.replace(/\/[^/]+$/, '');
    await ensureDir(parent);
    // Buffer.from is ~10× faster than the manual fromCharCode loop and uses
    // far less peak memory (no giant intermediate JS string).
    const out64 = Buffer.from(data).toString('base64');
    await FileSystem.writeAsStringAsync(fullPath, out64, { encoding: FileSystem.EncodingType.Base64 });
    count += 1;
    // Yield to the event loop every 50 files so the UI thread doesn't ANR.
    if (count % 50 === 0) await new Promise<void>((r) => setTimeout(r, 0));
  }
  // Mark extraction complete so we never read a partial dir on next launch.
  await FileSystem.writeAsStringAsync(marker, String(count), { encoding: FileSystem.EncodingType.UTF8 });
  return dataDir;
}

function stripFilePrefix(p: string): string {
  return p.startsWith('file://') ? p.slice(7) : p;
}

export async function initEngine(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    lastStep = 'check-native';
    if (!isPiperAvailable()) {
      lastError = 'Modulo nativo Sherpa non disponibile (anteprima Expo Go)';
      return false;
    }
    try {
      lastStep = 'mkdir';
      await ensureDir(DEST_DIR);

      lastStep = 'copy-model';
      const modelPathU = await copyAsset(PIPER_ASSETS.model, 'beppe.onnx');
      lastStep = 'copy-tokens';
      const tokensPathU = await copyAsset(PIPER_ASSETS.tokens, 'tokens.txt');
      lastStep = 'unzip-espeak';
      const dataDirPathU = await unzipEspeak(PIPER_ASSETS.espeakZip);

      const modelPath = stripFilePrefix(modelPathU);
      const tokensPath = stripFilePrefix(tokensPathU);
      const dataDirPath = stripFilePrefix(dataDirPathU);

      lastStep = 'init-sherpa';
      const tts = getSherpaTTS()!;
      const cfg = {
        model: {
          vits: {
            model: modelPath,
            tokens: tokensPath,
            dataDir: dataDirPath,
            lengthScale: 1.0,
            noiseScale: 0.667,
            noiseScaleW: 0.8,
          },
          debug: 0,
          provider: 'cpu',
          numThreads: 2,
        },
        ruleFsts: '',
        ruleFars: '',
        maxNumSentences: 1,
      };
      await tts.initialize(JSON.stringify(cfg));
      ready = true;
      lastStep = 'ready';
      lastError = null;
      console.log('[Piper] On-device engine ready');
      return true;
    } catch (e: any) {
      ready = false;
      lastError = `${lastStep}: ${e?.message || String(e)}`;
      console.warn('[Piper] init failed:', lastError);
      return false;
    }
  })();
  return initPromise;
}

export function isPiperReady(): boolean {
  return ready;
}

export async function speakSentence(text: string, lengthScale: number): Promise<void> {
  const tts = getSherpaTTS();
  if (!tts || !ready) throw new Error('Piper not available');
  const speed = Math.max(0.5, Math.min(2.0, 1 / lengthScale));
  await tts.generateAndPlay(text, 0, speed);
}

export async function stopSpeak(): Promise<void> {
  const tts = getSherpaTTS();
  if (!tts) return;
  try {
    await tts.deinitialize();
  } catch {
    /* ignore */
  }
  ready = false;
  initPromise = null;
  initEngine();
}

export const piperPlatformOk = Platform.OS === 'android' || Platform.OS === 'ios';
