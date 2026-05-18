// Dynamic voice import — user-loaded Piper voices.
//
// ┌─────────────────────────────────────────────────────────────────┐
// │ ARCHITECTURE                                                    │
// │                                                                 │
// │ Bundled voices live in /assets/piper/voices/<id>/ and ship with │
// │ the APK (read-only at runtime via Metro require.context).       │
// │                                                                 │
// │ Dynamic voices live on the device's writable storage:           │
// │   FileSystem.documentDirectory/piper/dynamic_voices/<id>/       │
// │     ├── model.onnx                                              │
// │     └── model.onnx.json                                         │
// │                                                                 │
// │ A JSON manifest is kept in AsyncStorage so we can render the    │
// │ catalog without scanning the filesystem on every app launch:    │
// │   @piper/dynamic_voices_manifest_v1 → DynamicVoiceMeta[]        │
// │                                                                 │
// │ Both bundled and dynamic voices share the same VoiceMeta shape  │
// │ so the picker UI doesn't care which is which. The engine        │
// │ branches in doInitEngine: bundled → unpack from assets;         │
// │ dynamic → use the absolute filesystem path directly.            │
// └─────────────────────────────────────────────────────────────────┘
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Buffer } from 'buffer';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { unzipSync } from 'fflate';
import type { VoiceMeta } from './piperAssets';

export const DYNAMIC_VOICES_DIR = `${FileSystem.documentDirectory}piper/dynamic_voices`;
const MANIFEST_KEY = '@piper/dynamic_voices_manifest_v1';

// Hard cap: refuse to import a model > 250 MB to protect the device's
// storage and the user from "I picked the wrong file" mistakes.
const MAX_MODEL_BYTES = 250 * 1024 * 1024;

export type DynamicVoiceMeta = VoiceMeta & {
  /** Marker that lets the engine know to use the FS path directly. */
  isDynamic: true;
  /** Absolute path to model.onnx on the device's writable storage. */
  modelPath: string;
  /** Absolute path to model.onnx.json on the device's writable storage. */
  configPath: string;
  /** ISO timestamp of when the voice was imported. */
  importedAt: string;
};

// =========================================================================
// MANIFEST
// =========================================================================

export async function listDynamicVoices(): Promise<DynamicVoiceMeta[]> {
  try {
    const raw = await AsyncStorage.getItem(MANIFEST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DynamicVoiceMeta[];
    // Filter out voices whose files are missing (e.g. user wiped storage)
    const filtered: DynamicVoiceMeta[] = [];
    for (const v of parsed) {
      try {
        const info_ = await FileSystem.getInfoAsync(v.modelPath);
        if (info_.exists) filtered.push(v);
      } catch {
        // skip
      }
    }
    // Persist the cleaned list back if it changed
    if (filtered.length !== parsed.length) {
      await saveManifest(filtered);
    }
    return filtered;
  } catch {
    return [];
  }
}

async function saveManifest(voices: DynamicVoiceMeta[]): Promise<void> {
  await AsyncStorage.setItem(MANIFEST_KEY, JSON.stringify(voices));
}

export async function getDynamicVoice(id: string): Promise<DynamicVoiceMeta | null> {
  const all = await listDynamicVoices();
  return all.find((v) => v.id === id) || null;
}

// =========================================================================
// IMPORT FLOW
// =========================================================================

/**
 * Open the document picker so the user can choose either:
 *   (a) a single .zip file containing model.onnx + model.onnx.json, OR
 *   (b) two files (.onnx and .onnx.json) selected together.
 *
 * Returns the newly imported voice metadata, or null if the user cancels.
 * Throws a user-readable error on any failure.
 */
export async function importVoice(): Promise<DynamicVoiceMeta | null> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    type: '*/*', // wildcard so users can pick whatever they have
    copyToCacheDirectory: true,
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }

  const assets = result.assets;

  // Case A: user picked a single .zip file
  if (assets.length === 1) {
    const a = assets[0];
    const nameLower = (a.name || '').toLowerCase();
    if (nameLower.endsWith('.zip')) {
      return await importFromZip(a.uri, a.name || 'voice.zip');
    }
    // Common error: user only picked the .onnx OR only the .json
    if (nameLower.endsWith('.onnx')) {
      throw new Error(
        'Hai selezionato solo il file .onnx. Seleziona anche il file .onnx.json ' +
          'corrispondente (tieni premuto per selezione multipla), oppure carica ' +
          'un singolo file .zip che contenga entrambi.',
      );
    }
    if (nameLower.endsWith('.json')) {
      throw new Error(
        'Hai selezionato solo il file .onnx.json. Seleziona anche il file .onnx ' +
          'corrispondente (tieni premuto per selezione multipla), oppure carica ' +
          'un singolo file .zip che contenga entrambi.',
      );
    }
    throw new Error(
      `Formato non supportato: "${a.name}". Seleziona un file .zip contenente ` +
        'model.onnx + model.onnx.json, oppure entrambi i file separatamente.',
    );
  }

  // Case B: user picked multiple files — look for .onnx and .onnx.json
  return await importFromFiles(assets);
}

async function importFromFiles(
  assets: DocumentPicker.DocumentPickerAsset[],
): Promise<DynamicVoiceMeta> {
  const onnxAsset = assets.find((a) => (a.name || '').toLowerCase().endsWith('.onnx'));
  const jsonAsset = assets.find(
    (a) => (a.name || '').toLowerCase().endsWith('.onnx.json') ||
           (a.name || '').toLowerCase().endsWith('.json'),
  );
  if (!onnxAsset || !jsonAsset) {
    throw new Error(
      'Servono entrambi i file: model.onnx (il modello) e model.onnx.json ' +
        '(la configurazione). Riprova selezionandoli insieme dal picker.',
    );
  }
  if (onnxAsset.size && onnxAsset.size > MAX_MODEL_BYTES) {
    throw new Error(`File modello troppo grande (${Math.round(onnxAsset.size / 1024 / 1024)} MB > ${MAX_MODEL_BYTES / 1024 / 1024} MB).`);
  }

  // Read and parse the JSON sidecar so we can build metadata before we
  // commit the import.
  const configRaw = await FileSystem.readAsStringAsync(jsonAsset.uri);
  const configJson = parseAndValidateConfig(configRaw);

  const voiceId = generateVoiceId(jsonAsset.name || onnxAsset.name || 'voice', configJson);
  const voiceDir = `${DYNAMIC_VOICES_DIR}/${voiceId}`;
  await ensureDir(voiceDir);

  const modelDest = `${voiceDir}/model.onnx`;
  const configDest = `${voiceDir}/model.onnx.json`;

  await FileSystem.copyAsync({ from: onnxAsset.uri, to: modelDest });
  await FileSystem.writeAsStringAsync(configDest, JSON.stringify(configJson));

  return await registerVoice(voiceId, modelDest, configDest, configJson, onnxAsset.size || 0);
}

async function importFromZip(zipUri: string, zipName: string): Promise<DynamicVoiceMeta> {
  const info_ = await FileSystem.getInfoAsync(zipUri, { size: true } as any);
  if ((info_ as any).size && (info_ as any).size > MAX_MODEL_BYTES + 50 * 1024 * 1024) {
    throw new Error(`Archivio ZIP troppo grande.`);
  }
  // Read the zip as base64, then decode to bytes
  const b64 = await FileSystem.readAsStringAsync(zipUri, { encoding: FileSystem.EncodingType.Base64 });
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  const entries = unzipSync(bytes);

  // Find the .onnx and .onnx.json files inside (case-insensitive; ignore
  // any subdirectories — flatten by basename).
  let onnxName: string | null = null;
  let jsonName: string | null = null;
  for (const name of Object.keys(entries)) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.onnx') && !lower.endsWith('.onnx.json') && !onnxName) onnxName = name;
    else if ((lower.endsWith('.onnx.json') || lower.endsWith('.json')) && !jsonName) jsonName = name;
  }
  if (!onnxName || !jsonName) {
    throw new Error(
      `Archivio ZIP "${zipName}" non contiene sia il file .onnx che il file .onnx.json. ` +
        `Trovati: [${Object.keys(entries).join(', ')}]`,
    );
  }

  const onnxBytes = entries[onnxName];
  const jsonBytes = entries[jsonName];

  if (onnxBytes.length > MAX_MODEL_BYTES) {
    throw new Error(`Modello troppo grande (${Math.round(onnxBytes.length / 1024 / 1024)} MB).`);
  }

  const configRaw = new TextDecoder('utf-8').decode(jsonBytes);
  const configJson = parseAndValidateConfig(configRaw);

  const voiceId = generateVoiceId(zipName, configJson);
  const voiceDir = `${DYNAMIC_VOICES_DIR}/${voiceId}`;
  await ensureDir(voiceDir);

  const modelDest = `${voiceDir}/model.onnx`;
  const configDest = `${voiceDir}/model.onnx.json`;

  // Write the .onnx via base64 (no native binary write API in Expo)
  const onnxB64 = Buffer.from(onnxBytes).toString('base64');
  await FileSystem.writeAsStringAsync(modelDest, onnxB64, { encoding: FileSystem.EncodingType.Base64 });
  await FileSystem.writeAsStringAsync(configDest, JSON.stringify(configJson));

  return await registerVoice(voiceId, modelDest, configDest, configJson, onnxBytes.length);
}

// =========================================================================
// VOICE REGISTRATION
// =========================================================================

async function registerVoice(
  id: string,
  modelPath: string,
  configPath: string,
  configJson: Record<string, any>,
  modelBytes: number,
): Promise<DynamicVoiceMeta> {
  const espeakVoice: string = (configJson?.espeak?.voice || '').toLowerCase();
  const baseLang = espeakVoice.split('-')[0] || 'unknown';
  const langName =
    configJson?.language?.name_english ||
    configJson?.language?.name_native ||
    ESPEAK_LANG_NAME[baseLang] ||
    (espeakVoice ? `(${espeakVoice})` : 'Sconosciuta');
  const langCode = configJson?.language?.code || espeakVoice || baseLang;
  const quality = configJson?.audio?.quality || 'custom';

  const meta: DynamicVoiceMeta = {
    id,
    name: prettyName(id),
    language: langName,
    language_code: langCode,
    quality,
    size_mb: Math.round((modelBytes || 0) / (1024 * 1024)),
    description: `Voce importata (espeak=${espeakVoice || '?'})`,
    flag: ESPEAK_FLAG[baseLang] || '🎤',
    isDynamic: true,
    modelPath,
    configPath,
    importedAt: new Date().toISOString(),
  };

  // Push into manifest (dedup by id — overwrite if user re-imports)
  const all = await listDynamicVoices();
  const filtered = all.filter((v) => v.id !== id);
  filtered.push(meta);
  await saveManifest(filtered);
  return meta;
}

// =========================================================================
// DELETE
// =========================================================================

export async function deleteDynamicVoice(id: string): Promise<void> {
  const all = await listDynamicVoices();
  const v = all.find((x) => x.id === id);
  if (v) {
    try {
      await FileSystem.deleteAsync(`${DYNAMIC_VOICES_DIR}/${id}`, { idempotent: true });
    } catch {
      /* ignore */
    }
  }
  const filtered = all.filter((x) => x.id !== id);
  await saveManifest(filtered);
}

// =========================================================================
// HELPERS
// =========================================================================

async function ensureDir(path: string): Promise<void> {
  const info_ = await FileSystem.getInfoAsync(path);
  if (!info_.exists) {
    await FileSystem.makeDirectoryAsync(path, { intermediates: true });
  }
}

/**
 * Validate the .onnx.json structure. Throws if mandatory fields are missing.
 * Returns the parsed object on success.
 */
function parseAndValidateConfig(raw: string): Record<string, any> {
  let parsed: Record<string, any>;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`File JSON non valido: ${e?.message || e}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Il file JSON deve essere un oggetto.');
  }
  if (!parsed.phoneme_id_map || typeof parsed.phoneme_id_map !== 'object') {
    throw new Error(
      'JSON Piper non valido: manca "phoneme_id_map". ' +
        'Verifica di aver scelto il file model.onnx.json corretto.',
    );
  }
  if (!parsed.audio?.sample_rate) {
    // Not strictly required (we default to 22050) but warn
    parsed.audio = parsed.audio || {};
    if (!parsed.audio.sample_rate) parsed.audio.sample_rate = 22050;
  }
  if (!parsed.espeak?.voice) {
    parsed.espeak = parsed.espeak || {};
    parsed.espeak.voice = parsed.espeak.voice || 'it'; // default to Italian
  }
  return parsed;
}

/**
 * Build a stable, filesystem-safe voice ID from the source filename and
 * the language metadata. Prefixed with "custom_" to never collide with
 * bundled voice IDs.
 */
function generateVoiceId(sourceName: string, config: Record<string, any>): string {
  const base = sourceName
    .replace(/\.zip$/i, '')
    .replace(/\.onnx\.json$/i, '')
    .replace(/\.onnx$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 32);
  const stub = base || 'voice';
  const langPart = (config?.espeak?.voice || '').toLowerCase().split('-')[0] || 'xx';
  return `custom_${langPart}_${stub}`;
}

function prettyName(id: string): string {
  const cleaned = id.replace(/^custom_[a-z]{2,}_/i, '');
  return cleaned
    .split(/[_-]/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ') || id;
}

const ESPEAK_LANG_NAME: Record<string, string> = {
  it: 'Italiano',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  pt: 'Português',
  ru: 'Русский',
  nl: 'Nederlands',
  pl: 'Polski',
  ca: 'Català',
  ro: 'Română',
  el: 'Ελληνικά',
  tr: 'Türkçe',
  uk: 'Українська',
  ar: 'العربية',
  hi: 'हिन्दी',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
};

const ESPEAK_FLAG: Record<string, string> = {
  it: '🇮🇹',
  en: '🇬🇧',
  es: '🇪🇸',
  fr: '🇫🇷',
  de: '🇩🇪',
  pt: '🇵🇹',
  ru: '🇷🇺',
  nl: '🇳🇱',
  pl: '🇵🇱',
  ca: '🇪🇸',
  ro: '🇷🇴',
  el: '🇬🇷',
  tr: '🇹🇷',
  uk: '🇺🇦',
  ar: '🇸🇦',
  hi: '🇮🇳',
  zh: '🇨🇳',
  ja: '🇯🇵',
  ko: '🇰🇷',
};
