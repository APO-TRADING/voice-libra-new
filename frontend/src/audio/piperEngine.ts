// On-device Piper TTS engine using react-native-sherpa-onnx-offline-tts.
// Real-time, no server, no disk audio cache — assets are copied once to the
// app's documents dir at first run, then synthesis happens fully in-memory
// via the native module.
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { PIPER_ASSETS } from './piperAssets';
import { getSherpaTTS, isPiperAvailable } from './sherpaPiper';

let initPromise: Promise<boolean> | null = null;
let ready = false;

async function copyAsset(modId: number, destName: string): Promise<string> {
  const asset = Asset.fromModule(modId);
  await asset.downloadAsync();
  const src = asset.localUri || asset.uri;
  const dir = `${FileSystem.documentDirectory}piper`;
  const dest = `${dir}/${destName}`;
  const exists = await FileSystem.getInfoAsync(dest);
  if (!exists.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    await FileSystem.copyAsync({ from: src, to: dest });
  }
  return dest;
}

export async function initEngine(): Promise<boolean> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!isPiperAvailable()) return false;
    if (!PIPER_ASSETS) {
      console.log('[Piper] PIPER_ASSETS is null — see src/audio/piperAssets.ts to enable.');
      return false;
    }
    try {
      const modelPath = await copyAsset(PIPER_ASSETS.model, 'beppe.onnx');
      await copyAsset(PIPER_ASSETS.config, 'beppe.onnx.json');
      const tokensPath = await copyAsset(PIPER_ASSETS.tokens, 'tokens.txt');
      const tts = getSherpaTTS()!;
      const modelDir = modelPath.replace(/\/[^/]+$/, '');
      try {
        await tts.initialize(modelDir);
      } catch {
        const cfg = JSON.stringify({
          modelPath,
          tokensPath,
          dataDirPath: `${modelDir}/espeak-ng-data`,
        });
        await tts.initialize(cfg);
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
