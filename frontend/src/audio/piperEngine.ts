// On-device Piper TTS engine using react-native-sherpa-onnx-offline-tts.
// Real-time, offline, no server. All Piper assets are pre-bundled in the APK
// (see /app/frontend/assets/piper/ and src/audio/piperAssets.ts).
//
// At first launch the engine:
//   1) Copies beppe.onnx / beppe.onnx.json / tokens.txt to documentDirectory/piper/
//   2) Unzips espeak-ng-data.zip to documentDirectory/piper/espeak-ng-data/
//   3) Initialises sherpa-onnx with these absolute paths
//
// Subsequent launches skip the copy/unzip if files already exist.
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { PIPER_ASSETS } from './piperAssets';
import { getSherpaTTS, isPiperAvailable } from './sherpaPiper';

let initPromise: Promise<boolean> | null = null;
let ready = false;

const DEST_DIR = `${FileSystem.documentDirectory}piper`;

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DEST_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DEST_DIR, { intermediates: true });
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

async function unzipEspeak(modId: number): Promise<string> {
  const dataDir = `${DEST_DIR}/espeak-ng-data`;
  const info = await FileSystem.getInfoAsync(dataDir);
  if (info.exists && info.isDirectory) return dataDir;

  const zipPath = await copyAsset(modId, 'espeak-ng-data.zip');
  // Lazy import: react-native-zip-archive needs native bridge; absent in Expo Go.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { unzip } = require('react-native-zip-archive') as { unzip: (src: string, dest: string) => Promise<string> };
  // The zip already contains an "espeak-ng-data" folder at its root, so we
  // unzip into DEST_DIR which yields DEST_DIR/espeak-ng-data/.
  await unzip(zipPath, DEST_DIR);
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
      await ensureDir();
      const modelPath = await copyAsset(PIPER_ASSETS.model, 'beppe.onnx');
      await copyAsset(PIPER_ASSETS.config, 'beppe.onnx.json');
      const tokensPath = await copyAsset(PIPER_ASSETS.tokens, 'tokens.txt');
      const dataDirPath = await unzipEspeak(PIPER_ASSETS.espeakZip);

      const tts = getSherpaTTS()!;
      // The library accepts either a directory string or a JSON config string.
      // Prefer the explicit JSON config — most reliable across versions.
      const cfg = JSON.stringify({
        modelPath,
        tokensPath,
        dataDirPath,
      });
      try {
        await tts.initialize(cfg);
      } catch {
        // Fallback: pass directory (some forks accept it directly)
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
  // Re-arm engine for next play
  initEngine();
}

export const piperPlatformOk = Platform.OS === 'android' || Platform.OS === 'ios';
