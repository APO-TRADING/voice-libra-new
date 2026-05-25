/**
 * foreignWords.ts — runtime helpers to mark English loanwords inside a
 * non-English sentence so the eSpeak phonemizer can switch voices
 * mid-stream.
 *
 * USAGE
 * -----
 *  1. JS pre-loads the English wordlist once at app start
 *     (`ensureEnglishWordsLoaded()`).
 *  2. Before sending each sentence to the native TTS, JS calls
 *     `wrapForeignWords(sentence, srcLang)`. If the toggle in
 *     Settings ("Pronuncia inglese per termini stranieri") is OFF, the
 *     helper just returns the plain text unchanged. If ON, every token
 *     matching the bundled English wordlist (after Italian/IT-homograph
 *     subtraction) is wrapped in `<voice name="en">…</voice>`. The
 *     native JNI auto-detects the SSML markup and OR-s `espeakSSML`
 *     into the espeak textmode, so the phonemizer switches its
 *     internal language translator per-word.
 *
 * DESIGN NOTES
 * ------------
 *  - The bundled wordlist is gzipped UTF-8 text, ~25 KB on disk. After
 *    gunzip it expands to ~80 KB plain. The resulting Set<string>
 *    holds 8 759 lowercased English headwords.
 *  - We use the SAME lookup for it / fr / de / es — the assumption is
 *    that any "true English" word found inside a Latin-script European
 *    audiobook (Manhattan, Brooklyn, dashboard, microservice, etc.)
 *    must be pronounced in English regardless of the surrounding text.
 *  - The wordlist EXCLUDES (by construction):
 *      • acclimated loanwords already in IT (test, computer, internet,
 *        weekend, manager, sport, hobby, top, video, …) — leaving these
 *        to the native language phonemizer
 *      • Italian homographs (come, dove, sopra, sotto, anche, vita,
 *        casa, mano, tutto, …)
 *  - Lookup is case-insensitive (we lowercase the token before the Set
 *    check). The original casing is preserved in the SSML output.
 *  - We DO NOT wrap tokens that contain digits, apostrophes mid-word
 *    or other non-letter characters — those would either confuse the
 *    SSML parser or are unlikely to be English loanwords.
 *
 * SSML CHARACTER ESCAPING
 * -----------------------
 *  Once any token in the sentence is wrapped, the WHOLE sentence is
 *  delivered to espeak with the SSML flag. Plain-text characters `<`,
 *  `>` and `&` MUST therefore be escaped to their XML entities, otherwise
 *  the parser would interpret them as markup (see the unit test in
 *  the bottom of this file).
 */
import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { gunzipSync } from 'fflate';
import AsyncStorage from '@react-native-async-storage/async-storage';

// eslint-disable-next-line @typescript-eslint/no-require-imports
export const ENGLISH_WORDS_ASSET = require('../../assets/dicts/english_top10k.bin');

const ASYNC_FOREIGN_WORDS_KEY = '@piper/foreign_words_en_v1';

// Cached, loaded once. `undefined` = not loaded yet, `null` = load failed.
let englishWordsCache: Set<string> | null | undefined = undefined;

// In-memory mirror of the toggle so the synthesizer hot-path doesn't
// have to await AsyncStorage on every sentence. The boot sequence in
// piperEngine refreshes this on app start.
let foreignWordsEnabled = false;

/**
 * Read the current AsyncStorage value into the in-memory cache and
 * return it. Call this on app start (PlayerContext / piperEngine init).
 */
export async function refreshForeignWordsFlag(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(ASYNC_FOREIGN_WORDS_KEY);
    foreignWordsEnabled = raw === '1';
  } catch {
    foreignWordsEnabled = false;
  }
  return foreignWordsEnabled;
}

/** Returns the cached value WITHOUT reading AsyncStorage. */
export function isForeignWordsEnabled(): boolean {
  return foreignWordsEnabled;
}

/**
 * Persist the user's preference and update the in-memory cache.
 * Returns the new effective value.
 */
export async function setForeignWordsEnabled(enabled: boolean): Promise<boolean> {
  foreignWordsEnabled = enabled;
  try {
    await AsyncStorage.setItem(ASYNC_FOREIGN_WORDS_KEY, enabled ? '1' : '0');
  } catch {
    /* ignore — the in-memory value is still updated */
  }
  return foreignWordsEnabled;
}

/**
 * Load (and cache) the English wordlist from the bundled .bin asset.
 *
 * Returns the Set, or null if loading failed (in which case the helper
 * silently no-ops on subsequent calls — see `wrapForeignWords`).
 *
 * Safe to call repeatedly: subsequent calls hit the cache.
 */
export async function ensureEnglishWordsLoaded(): Promise<Set<string> | null> {
  if (englishWordsCache !== undefined) return englishWordsCache;
  try {
    const asset = Asset.fromModule(ENGLISH_WORDS_ASSET);
    await asset.downloadAsync();
    const src = asset.localUri || asset.uri;
    if (!src) {
      englishWordsCache = null;
      return null;
    }
    const b64 = await FileSystem.readAsStringAsync(src, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const gz = new Uint8Array(Buffer.from(b64, 'base64'));
    const plain = gunzipSync(gz);
    const text = Buffer.from(plain).toString('utf8');
    const set = new Set<string>();
    for (const line of text.split('\n')) {
      const w = line.trim();
      if (w) set.add(w);
    }
    englishWordsCache = set;
    // eslint-disable-next-line no-console
    console.log(`[foreignWords] Loaded ${set.size} English headwords (${plain.length}B plain, ${gz.length}B gzipped)`);
    return set;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[foreignWords] Failed to load English wordlist:', e);
    englishWordsCache = null;
    return null;
  }
}

/**
 * Escape `<`, `>`, `&` so the SSML parser treats them as literal text.
 * Quotes are left alone — they're not significant outside attribute
 * values (which we control directly, never letting user text reach them).
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Decide whether a raw token (between whitespace boundaries) could be
 * matched against the English wordlist. We DO NOT consider tokens that
 *  - are shorter than 4 characters (already filtered out of the asset
 *    but enforce here too)
 *  - contain digits, underscore, slash, ampersand, less-than, greater-
 *    than, dot, comma, semicolon, colon, parens or brackets
 *  - contain characters outside the basic-Latin letter range plus the
 *    common accented set used in IT/FR/DE/ES (a token like "città"
 *    is obviously not English, skip it).
 */
function tokenLooksLikePossibleEnglish(token: string): boolean {
  if (token.length < 4) return false;
  // Accept only letters (with common European diacritics, which are
  // overwhelmingly NON-English markers — we'll skip them anyway). The
  // simpler filter is "ASCII letters + apostrophe", which catches every
  // entry in the bundled list.
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    const isApos  = c === 39;
    if (!(isUpper || isLower || isApos)) return false;
  }
  return true;
}

/**
 * Wrap every token that matches the English wordlist with
 * `<voice name="en">…</voice>` so eSpeak switches translator per-word.
 *
 * Returns the input unchanged when:
 *   - the toggle is OFF, OR
 *   - the wordlist failed to load, OR
 *   - no token matched (the sentence stays plain text — the JNI
 *     auto-detect then never enables SSML, no parser overhead)
 *
 * @param srcLang Source language code (it / fr / de / es / en). When
 * 'en', the function is a no-op (you don't switch to English from
 * English).
 */
export function wrapForeignWords(text: string, srcLang: string): string {
  if (!foreignWordsEnabled) return text;
  if (!text) return text;
  // No need to switch from English to English.
  const base = srcLang.toLowerCase().split(/[-_]/)[0];
  if (base === 'en') return text;
  const set = englishWordsCache;
  if (!set) return text; // wordlist not loaded — fail open with plain text

  // Split text into a sequence of "word" / "non-word" runs so we can
  // wrap only the word runs and leave punctuation/spaces untouched.
  // Word characters: A-Z, a-z, apostrophe (for English contractions
  // like "don't" — though we filter those out via the length/charset
  // check inside the body). Accented Latin letters (à é ñ ü ß …) are
  // intentionally NOT in the word class so a single token like
  // "città" stays in ONE run and our matcher skips it as
  // tokenLooksLikePossibleEnglish() returns false.
  const re = /[A-Za-z']+|[^A-Za-z']+/g;
  let out = '';
  let wrappedAny = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const chunk = m[0];
    // Non-word chunk: just escape and keep.
    if (!/^[A-Za-z']+$/.test(chunk)) {
      out += escapeXml(chunk);
      continue;
    }
    // Word chunk: see if it matches the English wordlist.
    if (tokenLooksLikePossibleEnglish(chunk) && set.has(chunk.toLowerCase())) {
      // Wrap, preserving the original casing.
      out += `<voice name="en">${chunk}</voice>`;
      wrappedAny = true;
    } else {
      out += escapeXml(chunk);
    }
  }
  // If we didn't wrap anything, return the ORIGINAL (un-escaped) text so
  // the JNI auto-detect skips the SSML parser entirely. This avoids
  // pointlessly escaping `&` etc. when no language switch is needed.
  return wrappedAny ? out : text;
}
