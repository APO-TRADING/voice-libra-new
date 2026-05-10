// On-device Piper TTS engine using react-native-sherpa-onnx-offline-tts.
// Real-time, offline, no server. All Piper assets are pre-bundled in the APK.
//
// At first launch the engine:
//   1) Copies beppe.onnx / beppe.onnx.json / tokens.txt to documentDirectory/piper/
//   2) Unzips espeak-ng-data.bin (a renamed zip) into documentDirectory/piper/espeak-ng-data/
//      using fflate (pure JS, no native deps).
//   3) Initialises sherpa-onnx with these absolute paths.
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { unzipSync } from 'fflate';
import { Platform } from 'react-native';
import { PIPER_ASSETS } from './piperAssets';
import { getSherpaTTS, isPiperAvailable } from './sherpaPiper';

let initPromise: Promise<boolean> | null = null;
let ready = false;

const DEST_DIR = `${FileSystem.documentDirectory}piper`;

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
  await FileSystem.copyAsync({ from: src, to: dest });
  return dest;
}

async function readAssetBytes(modId: number): Promise<Uint8Array> {
  const asset = Asset.fromModule(modId);
  await asset.downloadAsync();
  const src = asset.localUri || asset.uri;
  const b64 = await FileSystem.readAsStringAsync(src, { encoding: FileSystem.EncodingType.Base64 });
  // Decode base64 → Uint8Array (Hermes-friendly)
  const bin = globalThis.atob ? globalThis.atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function unzipEspeak(modId: number): Promise<string> {
  const dataDir = `${DEST_DIR}/espeak-ng-data`;
  const info = await FileSystem.getInfoAsync(dataDir);
  if (info.exists && info.isDirectory) return dataDir;

  const bytes = await readAssetBytes(modId);
  const entries = unzipSync(bytes);

  // Write each entry. The zip already contains an "espeak-ng-data/" top folder,
  // so writing into DEST_DIR yields DEST_DIR/espeak-ng-data/...
  for (const [name, data] of Object.entries(entries)) {
    const fullPath = `${DEST_DIR}/${name}`;
    if (name.endsWith('/') || data.length === 0) {
      await ensureDir(fullPath);
      continue;
    }
    const parent = fullPath.replace(/\/[^/]+$/, '');
    await ensureDir(parent);
    // fflate gives raw bytes; write via base64
    let b64 = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < data.length; i += CHUNK) {
      const slice = data.subarray(i, i + CHUNK);
      b64 += String.fromCharCode.apply(null, Array.from(slice));
    }
    const encoded = globalThis.btoa ? globalThis.btoa(b64) : Buffer.from(b64, 'binary').toString('base64');
    await FileSystem.writeAsStringAsync(fullPath, encoded, { encoding: FileSystem.EncodingType.Base64 });
  }
  return dataDir;
}

export async function initEngine(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!isPiperAvailable()) {
      console.log('[Piper] Native module unavailable (Expo Go preview). Using device TTS fallback.');
      return false;
    }
    try {
      await ensureDir(DEST_DIR);
      const modelPath = await copyAsset(PIPER_ASSETS.model, 'beppe.onnx');
      await copyAsset(PIPER_ASSETS.config, 'beppe.onnx.json');
      const tokensPath = await copyAsset(PIPER_ASSETS.tokens, 'tokens.txt');
      const dataDirPath = await unzipEspeak(PIPER_ASSETS.espeakZip);

      const tts = getSherpaTTS()!;
      const cfg = JSON.stringify({
        modelPath,
        tokensPath,
        dataDirPath,
      });
      try {
        await tts.initialize(cfg);
      } catch {
        await tts.initialize(DEST_DIR);
      }
      ready = true;
      console.log('[Piper] On-device engine ready');
      return true;
    } catch (e) {
      console.warn('[Piper] init failed:', e);
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
  // Piper length_scale: >1 slower, <1 faster.
  // sherpa "speed": 1 = normal, higher = faster.
  const speed = Math.max(0.5, Math.min(2.0, 1 / lengthScale));
  await tts.generateAndPlay(text, 0, speed);
}

export async function stopSpeak(): Promise<void> {
  const tts = getSherpaTTS();
  if (!tts) return;
  try {
    await tts.deinitialize();
  } catch {
    // ignore
  }
  ready = false;
  initPromise = null;
  initEngine();
}

export const piperPlatformOk = Platform.OS === 'android' || Platform.OS === 'ios';
