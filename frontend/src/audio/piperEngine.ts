// On-device Piper TTS engine using react-native-sherpa-onnx-offline-tts.
// Real-time, offline, no server. Assets are pre-bundled in the APK.
//
// At first launch:
//   1) Copy beppe.onnx + beppe.onnx.json to documents/piper/
//   2) Auto-generate tokens.txt from the phoneme_id_map inside beppe.onnx.json
//      (so the user only needs to ship 2 files: the .onnx and its .json)
//   3) Unzip espeak-ng-data.bin → documents/piper/espeak-ng-data/
//   4) Init sherpa-onnx with full OfflineTtsConfig
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

// Build a sherpa-onnx compatible tokens.txt from the Piper phoneme_id_map.
// Format: one line per token, "<symbol> <id>" — IDs sorted ascending.
async function generateTokensFromConfig(configPath: string): Promise<string> {
  const dest = `${DEST_DIR}/tokens.txt`;
  const info = await FileSystem.getInfoAsync(dest);
  if (info.exists) return dest;
  const raw = await FileSystem.readAsStringAsync(configPath, { encoding: FileSystem.EncodingType.UTF8 });
  const cfg = JSON.parse(raw) as { phoneme_id_map?: Record<string, number[]> };
  const map = cfg.phoneme_id_map;
  if (!map || typeof map !== 'object') {
    throw new Error("beppe.onnx.json non contiene 'phoneme_id_map'");
  }
  // Flatten: each symbol may map to a list of ids (most have 1).
  const pairs: { id: number; sym: string }[] = [];
  for (const sym of Object.keys(map)) {
    const ids = map[sym];
    if (Array.isArray(ids) && ids.length > 0 && typeof ids[0] === 'number') {
      pairs.push({ id: ids[0], sym });
    }
  }
  pairs.sort((a, b) => a.id - b.id);
  const lines = pairs.map((p) => `${p.sym === ' ' ? '<space>' : p.sym} ${p.id}`);
  // sherpa-onnx convention: blank line for space if needed; some forks expect
  // literal space. We use <space> sentinel for the ' ' symbol if present, and
  // also write an explicit space row to be safe.
  await FileSystem.writeAsStringAsync(dest, lines.join('\n') + '\n', { encoding: FileSystem.EncodingType.UTF8 });
  return dest;
}

async function unzipEspeak(modId: number): Promise<string> {
  const dataDir = `${DEST_DIR}/espeak-ng-data`;
  const info = await FileSystem.getInfoAsync(dataDir);
  if (info.exists && info.isDirectory) return dataDir;

  const asset = Asset.fromModule(modId);
  await asset.downloadAsync();
  const src = asset.localUri || asset.uri;
  if (!src) throw new Error('espeak-ng-data.bin: localUri vuoto');
  const b64 = await FileSystem.readAsStringAsync(src, { encoding: FileSystem.EncodingType.Base64 });
  const bin = globalThis.atob ? globalThis.atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const entries = unzipSync(bytes);

  for (const [name, data] of Object.entries(entries)) {
    const fullPath = `${DEST_DIR}/${name}`;
    if (name.endsWith('/') || data.length === 0) {
      await ensureDir(fullPath);
      continue;
    }
    const parent = fullPath.replace(/\/[^/]+$/, '');
    await ensureDir(parent);
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < data.length; i += CHUNK) {
      const slice = data.subarray(i, i + CHUNK);
      s += String.fromCharCode.apply(null, Array.from(slice));
    }
    const out64 = globalThis.btoa ? globalThis.btoa(s) : Buffer.from(s, 'binary').toString('base64');
    await FileSystem.writeAsStringAsync(fullPath, out64, { encoding: FileSystem.EncodingType.Base64 });
  }
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
      lastStep = 'copy-config';
      const configPathU = await copyAsset(PIPER_ASSETS.config, 'beppe.onnx.json');
      lastStep = 'gen-tokens';
      const tokensPathU = await generateTokensFromConfig(configPathU);
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
