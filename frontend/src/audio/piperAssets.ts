// Auto-discovered Piper voice registry.
//
// ┌─────────────────────────────────────────────────────────────────┐
// │ HOW TO ADD A VOICE                                              │
// │                                                                 │
// │ 1. Create a folder under assets/piper/voices/<voice_id>/        │
// │ 2. Drop in ONE pair of files: <anything>.onnx + <anything>.onnx.json
// │    (they must share the same base name).                        │
// │ 3. Rebuild the APK (`eas build`). No code change required.      │
// │                                                                 │
// │ Examples — all three voices below are auto-detected:            │
// │   voices/                                                       │
// │   ├── beppe/                                                    │
// │   │   ├── model.onnx           ← HuggingFace classic naming     │
// │   │   └── model.onnx.json                                       │
// │   ├── riccardo/                                                 │
// │   │   ├── it_IT-riccardo-x_low.onnx        ← verbose HF naming  │
// │   │   └── it_IT-riccardo-x_low.onnx.json                        │
// │   └── paola/                                                    │
// │       ├── paola.onnx           ← name matches folder            │
// │       └── paola.onnx.json                                       │
// │                                                                 │
// │ The VOICE ID is ALWAYS the folder name (beppe / riccardo /      │
// │ paola). Filenames inside are flexible.                          │
// │                                                                 │
// │ OPTIONAL — Pretty display name + flag + description:            │
// │ Add an entry in assets/piper/voices.json keyed by voice id.     │
// │ If no entry, we auto-generate basic metadata from the .onnx.json│
// │ language fields.                                                │
// └─────────────────────────────────────────────────────────────────┘
import voicesManifest from '../../assets/piper/voices.json';

export type VoiceMeta = {
  id: string;
  name: string;
  language: string;
  language_code: string;
  quality: string;
  size_mb: number;
  description: string;
  flag?: string;
};

export type VoiceAsset = {
  /** require() handle for the .onnx model (resolved by expo-asset). */
  model: number;
  /**
   * Parsed JSON sidecar (Metro inlines .json files as JS objects). We pass
   * its stringified form to the native side via native.loadVoice().
   */
  config: Record<string, unknown>;
};

const MANIFEST = voicesManifest as { default_voice?: string; voices?: VoiceMeta[] };
const MANIFEST_INDEX: Record<string, VoiceMeta> = {};
(MANIFEST.voices || []).forEach((v) => { MANIFEST_INDEX[v.id] = v; });

// Quick mapping for the most common espeak-ng voice codes -> display name
// and flag. Used when the .onnx.json's `language` field is null/missing
// (typical for community-trained custom voices). This avoids "Unknown" in
// the picker.
const ESPEAK_TO_LANG: Record<string, string> = {
  it: 'Italiano',
  en: 'English', 'en-us': 'English (US)', 'en-gb': 'English (UK)',
  es: 'Español', 'es-419': 'Español (LatAm)',
  fr: 'Français', 'fr-fr': 'Français (France)',
  de: 'Deutsch',
  pt: 'Português', 'pt-br': 'Português (BR)',
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
const ESPEAK_TO_FLAG: Record<string, string> = {
  it: '🇮🇹',
  en: '🇬🇧', 'en-us': '🇺🇸', 'en-gb': '🇬🇧',
  es: '🇪🇸', 'es-419': '🇲🇽',
  fr: '🇫🇷', 'fr-fr': '🇫🇷',
  de: '🇩🇪',
  pt: '🇵🇹', 'pt-br': '🇧🇷',
  ru: '🇷🇺', nl: '🇳🇱', pl: '🇵🇱', ca: '🇪🇸', ro: '🇷🇴', el: '🇬🇷',
  tr: '🇹🇷', uk: '🇺🇦', ar: '🇸🇦', hi: '🇮🇳', zh: '🇨🇳', ja: '🇯🇵', ko: '🇰🇷',
};

// =========================================================================
// AUTO-DISCOVERY via Metro require.context
// =========================================================================
//
// require.context(directory, recursive, pattern) returns a function `ctx`
// with a `.keys()` array of all matching paths relative to `directory`.
// Calling `ctx(key)` returns the resolved asset module ID (for .onnx) or
// the parsed JSON object (for .onnx.json).
//
// Metro must have `transformer.unstable_allowRequireContext = true`
// in metro.config.js. We already set that.

// Match BOTH:
//   ./beppe/model.onnx        -> [ "model.onnx",  undefined ]
//   ./beppe/model.onnx.json   -> [ "model.onnx", ".json"    ]
// The .json detection uses the trailing optional ".json" capture group.
// `[^/]+` for the file basename allows arbitrary names like
// "it_IT-riccardo-x_low.onnx".
const VOICE_PATH_RE = /^\.\/([^/]+)\/([^/]+\.onnx)(\.json)?$/i;

type RawVoice = { model?: number; config?: Record<string, unknown>; modelBaseName?: string; configBaseName?: string };

function scanVoiceContext(): Record<string, RawVoice> {
  const collected: Record<string, RawVoice> = {};
  let ctx: any;
  try {
    // The pattern must be a literal so Metro can statically analyze it.
    ctx = (require as any).context(
      '../../assets/piper/voices',
      true,
      /\.(onnx|onnx\.json)$/i,
    );
  } catch (e) {
    // require.context not enabled — fall back to nothing. Most likely the
    // metro.config.js `unstable_allowRequireContext` flag is missing.
    // eslint-disable-next-line no-console
    console.warn('[piperAssets] require.context unavailable; no voices discovered.', e);
    return collected;
  }

  const keys: string[] = (ctx.keys && ctx.keys()) || [];
  for (const key of keys) {
    const m = VOICE_PATH_RE.exec(key);
    if (!m) continue;
    const [, voiceId, fileBase, dotJson] = m;
    const isJson = !!dotJson;
    const entry = (collected[voiceId] ||= {});
    try {
      const resolved = ctx(key);
      if (isJson) {
        entry.config = resolved as Record<string, unknown>;
        entry.configBaseName = fileBase + '.json';
      } else {
        entry.model = resolved as number;
        entry.modelBaseName = fileBase;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[piperAssets] failed to load ${key}:`, e);
    }
  }
  return collected;
}

const RAW = scanVoiceContext();

// Build the final maps. A voice is "valid" only if BOTH .onnx and .onnx.json
// were found in the same folder. Otherwise we skip it with a console warning
// (still visible in the trace via JS console mirroring).
export const PIPER_VOICES: Record<string, VoiceAsset> = {};
const DISCOVERED_META: VoiceMeta[] = [];

for (const [id, raw] of Object.entries(RAW)) {
  // On native (Android/iOS) `require()` of an asset returns a number
  // (the Metro asset module ID). On web it returns a string URL. We
  // accept BOTH so the voice picker still renders on web (where the
  // native TTS module is absent and the engine falls back gracefully).
  const modelOk = typeof raw.model === 'number' || typeof raw.model === 'string';
  if (!modelOk || !raw.config) {
    // eslint-disable-next-line no-console
    console.warn(`[piperAssets] voice "${id}" incomplete (model=${typeof raw.model}, config=${!!raw.config}). Skipping.`);
    continue;
  }
  // Sanity: warn if model basename and config basename don't match — usually
  // a sign of mis-paired files. We still accept them (the user might have
  // mixed names on purpose) but log it.
  if (raw.modelBaseName && raw.configBaseName &&
      raw.configBaseName !== `${raw.modelBaseName}.json`) {
    // eslint-disable-next-line no-console
    console.warn(`[piperAssets] voice "${id}": .onnx="${raw.modelBaseName}" but .json="${raw.configBaseName}" (basenames differ).`);
  }

  PIPER_VOICES[id] = { model: raw.model as number, config: raw.config };

  // Build display metadata. Prefer voices.json entry, else derive from the
  // .onnx.json sidecar itself. For models where `language` is null/missing
  // (common for custom-trained voices), we fall back to mapping the
  // espeak.voice code to a friendly language name.
  const manifestEntry = MANIFEST_INDEX[id];
  if (manifestEntry) {
    DISCOVERED_META.push(manifestEntry);
  } else {
    const cfg = raw.config as any;
    const espeakVoice = (cfg?.espeak?.voice || '').toLowerCase();
    const langName =
      cfg?.language?.name_english ||
      cfg?.language?.name_native ||
      ESPEAK_TO_LANG[espeakVoice] ||
      (espeakVoice ? `(${espeakVoice})` : 'Sconosciuta');
    const langCode = cfg?.language?.code || espeakVoice || '';
    DISCOVERED_META.push({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      language: langName,
      language_code: langCode,
      quality: cfg?.audio?.quality || 'custom',
      size_mb: 0, // unknown without filesystem stat — we don't ship one
      description: `Voce custom (espeak=${espeakVoice || '?'})`,
      flag: ESPEAK_TO_FLAG[espeakVoice] || '🎤',
    });
  }
}

// Sort: voices with manifest metadata first (preserved order), then alphabetic
// for auto-discovered ones. Default voice (from manifest) bubbles to the top.
const DEFAULT_ID = MANIFEST.default_voice || Object.keys(PIPER_VOICES)[0] || '';
DISCOVERED_META.sort((a, b) => {
  if (a.id === DEFAULT_ID) return -1;
  if (b.id === DEFAULT_ID) return 1;
  const ai = (MANIFEST.voices || []).findIndex((v) => v.id === a.id);
  const bi = (MANIFEST.voices || []).findIndex((v) => v.id === b.id);
  if (ai !== bi) return (ai === -1 ? 9999 : ai) - (bi === -1 ? 9999 : bi);
  return a.id.localeCompare(b.id);
});

export const VOICES_MANIFEST = {
  default_voice: DEFAULT_ID,
  voices: DISCOVERED_META,
};

export const DEFAULT_VOICE_ID = DEFAULT_ID;

// espeak-ng-data is shared by all voices and ships as a single .bin zip.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const ESPEAK_DATA_ZIP = require('../../assets/piper/espeak-ng-data.bin');

// Convenience: tells the engine if at least one voice is bundled.
export const HAS_BUNDLED_VOICES = DISCOVERED_META.length > 0;
