/**
 * foreignWords.ts — v1.0.4 JIT Phoneme-Mapping
 * ────────────────────────────────────────────
 * Heuristic, regex-based detector for English loanwords inside a
 * non-English audiobook chunk. For each detected token we pre-compute
 * the English IPA phoneme stream by calling the native espeak-ng
 * phonemizer (via `phonemizeAs(word, "en-us")`) and wrap the token
 * in a `<phoneme alphabet="espeak" ph="…">word</phoneme>` SSML tag.
 *
 * The resulting chunk is handed to `synthesizeToFile()`, which calls
 * the JNI SSML parser. The parser splices the pre-computed phonemes
 * directly into the output stream WITHOUT switching the espeak voice,
 * so the entire chunk is phonemized in ONE continuous Italian pass.
 * No more per-loanword voice resets, no more audible stop-and-go in
 * Piper VITS output.
 *
 * PIPELINE (per chunk, in the JS prebuffer hot path):
 *   raw text
 *     │
 *     ├─► tokenize on `\p{L}'`
 *     │
 *     ├─► for each candidate token:
 *     │     ├─► tokenIsLoanword(token)?            (regex grapheme rules)
 *     │     ├─► not in ITALIAN_WHITELIST?          (acclimatised stop-list)
 *     │     ├─► tokenIsLoanword().passes?
 *     │     ├─► await phonemizeAs(token,"en-us")   (native, ~5ms each)
 *     │     ├─► non-empty IPA?
 *     │     └─► splice <phoneme ph="IPA">token</phoneme> back into chunk
 *     │
 *     └─► sentence is forwarded to synthesizeToFile() WITH the SSML markup
 *
 * SCALE GUARANTEES:
 *   - Zero-overhead detection: a single linear pass over the chunk
 *     (no Set lookups against a 50k wordlist any more, no asset I/O
 *     at runtime).
 *   - Bounded native calls: thrillers run typically 0-3 loanwords per
 *     sentence; even 5 phonemizeAs() calls cost <30ms total on midrange
 *     phones, far below the natural audio gap the prebuffer hides.
 *   - SAFE FAIL-OPEN: any failure in tokenIsLoanword(), the native
 *     phonemizer, or even a malformed `ph` string → the original
 *     token text is kept (no SSML wrap, no tag), so the worst case is
 *     a single mispronounced loanword — never a silent or crashing
 *     audio chunk.
 *
 * v1.0.4 removes the 50k English wordlist + DE/ES/FR whitelists that
 * v2.7.7 used. Those assets are NOT bundled any more. The toggle
 * (Pronuncia inglese per termini stranieri) controls whether
 * `wrapForeignWords()` does anything at all — when OFF, this module
 * is an unconditional pass-through.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getPiperNative } from './piperBridge';

const ASYNC_FOREIGN_WORDS_KEY = '@piper/foreign_words_en_v1';

// In-memory mirror of the toggle so the synthesizer hot-path doesn't
// have to await AsyncStorage on every sentence.
let foreignWordsEnabled = false;

/**
 * Read the current AsyncStorage value into the in-memory cache and
 * return it. Called once at engine init (piperEngine.doInitEngine).
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
 * v1.0.4 — No-op for source compatibility with the v2.7.7 API.
 *
 * The previous implementation downloaded and gunzipped a ~90 KB
 * wordlist + per-language whitelist assets at boot. The new regex-
 * based detector needs no runtime data, so this function returns
 * immediately without doing any work.
 *
 * Kept around because `piperEngine.ts` still calls it on every
 * `doInitEngine()` — removing the call would have meant patching
 * the engine boot path too. Returning Promise<null> mirrors the
 * old "no-load" signal.
 */
export async function ensureEnglishWordsLoaded(): Promise<null> {
  // eslint-disable-next-line no-console
  console.log('[foreignWords] v1.0.4 JIT pipeline — no wordlist preload required');
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// 1. ITALIAN ACCLIMATISED WORDS — the words BELOW are anglicisms that
//    Italian speakers pronounce in their italianised form (often with
//    italian phonetics on the vowels and consonants). We MUST NOT wrap
//    them as English: the regex would catch a lot of them (sport →
//    cluster-final `rt`/short-vowel; hotel → ends `el`; etc.) and the
//    listener would get an unexpectedly American pronunciation.
//
//    The set is intentionally small (~95 entries) and hand-curated:
//    only the truly common Italian-acclimatised loanwords. Anything
//    else is fair game for the English phonemizer.
//
//    All entries are lower-cased — lookup is also case-insensitive.
// ──────────────────────────────────────────────────────────────────────
const ITALIAN_WHITELIST: ReadonlySet<string> = new Set<string>([
  // Sport & lifestyle
  'sport', 'fitness', 'wellness', 'beauty', 'spa',
  'jogging', 'footing', 'trekking', 'surf', 'snowboard',
  // Hospitality / travel
  'hotel', 'motel', 'bar', 'pub', 'club', 'lounge', 'resort',
  'check', 'cocktail', 'drink', 'happy', 'menu',
  // Office / tech (super-common)
  'computer', 'internet', 'online', 'offline', 'email', 'web',
  'file', 'link', 'mouse', 'click', 'chat', 'video', 'audio',
  'media', 'social', 'app', 'login', 'logout', 'password',
  'server', 'router', 'gadget', 'device', 'tablet', 'smartphone',
  // Media / fashion
  'film', 'movie', 'show', 'thriller', 'fashion', 'design',
  'designer', 'style', 'trend', 'leader', 'manager', 'staff',
  'team', 'marketing', 'business', 'meeting', 'partner',
  // Time / events
  'weekend', 'party', 'event', 'live', 'flash', 'breaking',
  // Food
  'sandwich', 'toast', 'snack', 'brunch', 'fast', 'food',
  'hamburger', 'pizza',  // already italian-pronounced anyway
  // Clothing
  'jeans', 'shorts', 'tshirt', 't-shirt', 'pullover',
  // Emotions / states
  'shock', 'stress', 'relax', 'cool', 'super', 'top', 'okay',
  // Misc common
  'taxi', 'bus', 'tram', 'parking', 'garage', 'box',
  'standard', 'optional', 'special', 'extra', 'master',
  'banner', 'logo', 'slogan', 'spot',
]);

// ──────────────────────────────────────────────────────────────────────
// 2. ENGLISH GRAPHEME CLUSTERS — patterns that are statistically very
//    unlikely in native Italian morphology and very likely in English
//    loanwords. Any one match upgrades the token to "loanword candidate".
//
//    Notes on each pattern (informed by Italian orthography rules):
//      - `ck` :  Italian uses `cc` or `c` before /k/, never `ck`. So
//                "Glock", "Bosch" (sh+ck combo), "shock" (whitelisted),
//                "Brooklyn", "lock" all trigger.
//      - `sh` :  Italian uses `sc(i|e)` or `sci`, never `sh`. Triggers
//                on "Bosch", "Sheriff", "Sherman", "Bishop", etc.
//      - `th` :  Never in italian, always english (Thompson, North,
//                Smith, Heath).
//      - `ph` :  Italian uses `f`, never `ph` (Phoenix, Philip,
//                alphabet, graph). Triggers wherever found.
//      - `wh` :  Italian has no `wh`. Triggers on "Whitney", "White".
//      - `gh` (not at end) : "Knight" (silent gh), "Bright" — italian
//                only has `ghi`, `ghe`. We require the gh NOT to be
//                followed by `e`, `i` (which IS the italian pattern).
//      - `ee` :  Italian double-vowel `ee` is extremely rare; "Lee",
//                "Dundee", "Speed", "Green", "Heath" all trigger.
//      - `oo` :  Same logic — "Bloomberg", "Moore", "Brook".
//      - `ay` (mid/end) : "Broadway", "Highway", "Friday". Italian
//                has no `ay` digraph.
//      - `ow` (mid/end) : "Brown", "Crowford", "Yellowstone".
//      - final `-nd`, `-rg`, `-ck`, `-rk`, `-rt` (after consonant) :
//                English compact final clusters. Italian words almost
//                always end in a vowel. We require the cluster to be
//                preceded by a vowel (so we don't catch "il", "del" etc.)
//                and the cluster itself to be at the END of the word.
//      - leading `Mc` / `Mac` + uppercase consonant : Scottish/Irish
//                patronymics — "McCaleb", "MacDonald".
//      - English keywords (avenue, boulevard, drive, street, highway,
//                road, broadway, plaza) — direct match on common urban
//                terms used in english-speaking thrillers.
//
//    EVERY pattern is unicode-aware (we use the `u` flag) so we won't
//    accidentally match across diacritic-modified letters.
// ──────────────────────────────────────────────────────────────────────

// Tier-A: clusters that are 100% non-italian (always trigger).
const RE_ENGLISH_CLUSTERS = [
  /ck/i,                          // Glock, Brooklyn, Dick
  /sh/i,                          // Sheriff, Bishop, Smith→Shire
  /sch/i,                         // Bosch, Schroeder — Italian uses sch only
                                  // before e/i ("schiena"/"scheletro"), but
                                  // even those still trigger here. Acceptable
                                  // tradeoff: the only italian words with
                                  // "sch" sequence are themselves rare and
                                  // an italian phonetic reading vs. an
                                  // english one is nearly indistinguishable
                                  // for the listener ("scheletro").
  /th/i,                          // Smith, Thompson, Heath, North
  /ph/i,                          // Phoenix, Philip, alphabet, graph (CONFIRMED
                                  // by product owner: italian never uses ph)
  /wh/i,                          // Whitney, White, Whitman
  /ch(?![eiy])/i,                 // Charlie, Brooch, Macho — italian only has
                                  // ch + e/i ("che"/"chi"). The /y/ exclusion
                                  // protects "chy" too (rare english cluster).
  /gh(?![ei])/i,                  // Knight, Bright, Borough — italian only
                                  // has gh + e/i ("ghetto"/"ghirlanda"). This
                                  // catches BOTH consonant-gh (Knight) and
                                  // vowel-gh (Heigh, Lough).
  /^kn/i,                         // Knight, Knee, Knife — italian word never
                                  // starts with "kn".
  /^ps/i,                         // Psycho, Pseudo — italian word never starts
                                  // with "ps" before a vowel either (other
                                  // than greek loanwords like "psicologo"
                                  // that are already italianised).
  /ee/i,                          // Lee, Dundee, Green, Speed
  /oo/i,                          // Bloomberg, Moore, Brook
  /ay(?:$|[^aeiouy])/i,           // Broadway$, Highway$, Friday$
  /ow(?:$|[^aeiouy])/i,           // Brown, Crowford, Yellowstone
];

// Tier-B: word-final compact consonant clusters preceded by a vowel.
// Italian almost never ends a word in a hard consonant — these are
// strong English markers.
const RE_FINAL_CLUSTERS = [
  /[aeiou](?:nd|rg|rk|rt|ck|lk|ng|st|sk)$/i,  // Sand, Burg, Mark, Hart, Kirk, Strong
  /[^aeiou]y$/i,                              // Connelly, Kennedy, Murphy,
                                              // Mary, Larry, Harry — italian
                                              // words never end in
                                              // consonant + y.
];

// Tier-C: Scottish/Irish patronymics. The capital letter constraint is
// key — we don't want to match "macchina" (Italian car) → no, that's
// `macc` not `mac` + consonant. But "MacDonald" or "McCaleb" lights up
// because the capital after `Mc/Mac` is uppercase (proper-noun signal).
const RE_PATRONYMIC = /^(?:Mc|Mac)[A-Z]/;

// Tier-D: explicit urban/keyword list — case-insensitive WHOLE-WORD
// matches.
const URBAN_KEYWORDS: ReadonlySet<string> = new Set<string>([
  'avenue', 'street', 'boulevard', 'drive', 'highway', 'road',
  'broadway', 'plaza', 'square', 'lane', 'court', 'place',
  // English-specific personal-title words that often appear next to
  // names in audiobooks. They trigger the en-us phonemizer for the
  // surrounding capitalised name too.
  'sheriff', 'deputy', 'detective', 'agent',
]);

// Tier-E: well-known US/UK proper nouns that the regex tiers cannot
// catch on their own (no obvious non-italian grapheme cluster). Hand-
// curated to cover the most common thriller geographies + a handful
// of frequent character surnames. Adding new entries is CHEAP — it's
// just a Set membership test.
const PROPER_NAMES_EN: ReadonlySet<string> = new Set<string>([
  // US toponyms
  'manhattan', 'sunset', 'hollywood', 'harlem', 'bronx', 'queens',
  'vegas', 'seattle', 'boston', 'denver', 'houston', 'austin',
  'dallas', 'miami', 'atlanta', 'memphis', 'detroit', 'portland',
  'pittsburgh', 'baltimore', 'philly', 'newark', 'staten',
  'westwood', 'beverly', 'malibu', 'venice', 'pasadena',
  'compton', 'oakland', 'berkeley', 'sacramento',
  // UK toponyms (occasionally appear in audiobooks)
  'london', 'thames', 'soho', 'camden', 'chelsea',
  // common english surnames not caught by clusters
  'donovan', 'sullivan', 'callahan', 'flanagan', 'morgan',
  'reagan', 'sloan', 'logan', 'cohen', 'allen',
  'jordan', 'nolan', 'lawson', 'jackson', 'wilson',
  'johnson', 'jefferson', 'anderson', 'robinson', 'thompson',
  'harrison', 'peterson', 'davidson', 'henderson',
  // common english given names (capitalised pattern in book text)
  'kevin', 'gavin', 'devin', 'colin', 'martin', 'justin',
  'austin', 'kenneth', 'harold', 'gerald', 'donald',
  'ronald', 'arnold', 'sheldon',
]);

/**
 * Pure-syntactic loanword classifier. Returns true if `token` looks
 * like an English word (or a proper noun very likely to be English).
 *
 * Rejects tokens that:
 *   - are too short (< 3 chars) — too many false positives ("the",
 *     "and" would italianise badly; we let them be).
 *   - contain digits, hyphens, apostrophes, or non-ASCII letters
 *     (italian "città" → contains `à` → not english).
 *   - are in the ITALIAN_WHITELIST acclimatised set.
 *
 * Accepts tokens that match ANY of the four detection tiers.
 */
function tokenIsLoanword(token: string): boolean {
  if (token.length < 3) return false;
  // Pure-ASCII letter check (rejects accented italian words like
  // "Andrò", "città", "perché").
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    if (!(isUpper || isLower)) return false;
  }
  const lower = token.toLowerCase();
  // Reject acclimatised italian loanwords.
  if (ITALIAN_WHITELIST.has(lower)) return false;
  // Urban / context keywords — instant match.
  if (URBAN_KEYWORDS.has(lower)) return true;
  // Curated US/UK proper nouns — instant match (Manhattan, Sunset,
  // Donovan, Sullivan… anything the regex tiers can't pattern-match
  // on its own).
  if (PROPER_NAMES_EN.has(lower)) return true;
  // Patronymic prefix (Mc/Mac + Uppercase).
  if (RE_PATRONYMIC.test(token)) return true;
  // Tier-A clusters.
  for (const re of RE_ENGLISH_CLUSTERS) {
    if (re.test(token)) return true;
  }
  // Tier-B final clusters.
  for (const re of RE_FINAL_CLUSTERS) {
    if (re.test(token)) return true;
  }
  return false;
}

/**
 * Escape `<`, `>`, `&`, `"` so the SSML parser treats them as literal
 * text. The double-quote is escaped because the SSML `ph="…"` attribute
 * itself is double-quoted on the C++ side, so a quote inside the
 * phoneme string would break parsing.
 */
function escapeXmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttribute(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Small LRU cache for the IPA strings we get back from the native
 * phonemizer. Audiobook text is highly repetitive (the same proper
 * nouns appear dozens of times per chapter — "Bosch", "Connelly",
 * "LAPD") so caching saves an enormous number of JNI round-trips.
 *
 * Cap kept intentionally small (256 entries × ~20B IPA = ~5 KB)
 * — anything more is wasted on rarely-repeating tokens.
 */
const PHONEME_CACHE = new Map<string, string>();
const PHONEME_CACHE_MAX = 256;

function cacheGet(key: string): string | undefined {
  return PHONEME_CACHE.get(key);
}

function cacheSet(key: string, value: string): void {
  if (PHONEME_CACHE.has(key)) PHONEME_CACHE.delete(key); // refresh LRU position
  PHONEME_CACHE.set(key, value);
  if (PHONEME_CACHE.size > PHONEME_CACHE_MAX) {
    // Drop oldest entry (Map preserves insertion order).
    const oldest = PHONEME_CACHE.keys().next().value;
    if (oldest !== undefined) PHONEME_CACHE.delete(oldest);
  }
}

/**
 * Public cache-clear hook used by Settings when the user toggles the
 * foreign-words flag back and forth (so a stale cache doesn't survive
 * a "Pronuncia inglese" → OFF → ON cycle).
 */
export function clearPhonemeCache(): void {
  PHONEME_CACHE.clear();
}

/**
 * v1.0.4 — JIT phoneme-mapping enrichment.
 *
 * Walks the chunk, detects English loanword candidates with the
 * regex classifier, fetches their en-us IPA via `phonemizeAs()` on
 * the native side, and substitutes them with
 *   `<phoneme alphabet="espeak" ph="…">word</phoneme>`
 * inline. Plain text characters are XML-escaped (`<`, `>`, `&`) so
 * they don't confuse the C++ SSML parser.
 *
 * Returns the input unchanged when:
 *   - the toggle is OFF, OR
 *   - the source language is already English, OR
 *   - no token matched the loanword regex.
 *
 * NEVER throws. A failure inside `phonemizeAs()` (engine not booted,
 * native module missing, unknown voice) is caught and the offending
 * token is left as plain text — the worst case is one mispronounced
 * loanword, never a synthesis crash.
 *
 * @param text     raw sentence text from the book
 * @param srcLang  source language code ("it" / "fr" / "de" / "es" / "en"…)
 */
export async function wrapForeignWords(text: string, srcLang: string): Promise<string> {
  if (!foreignWordsEnabled) return text;
  if (!text) return text;

  // No need to switch from English to English.
  const base = srcLang.toLowerCase().split(/[-_]/)[0];
  if (base === 'en') return text;

  // Bail out early if the native bridge doesn't expose phonemizeAs
  // (older builds of the .so, web preview, Expo Go etc.).
  const native = getPiperNative();
  const phonemizeFn = native && typeof native.phonemizeAs === 'function'
    ? native.phonemizeAs.bind(native)
    : null;
  if (!phonemizeFn) {
    // No native phonemizer → safe fallback: plain text, no SSML.
    return text;
  }

  // 1. First pass — tokenize and identify candidates.
  //    We process tokens UNIQUELY before issuing native calls (the
  //    same name often appears 3-5 times in a chunk) — that gives us
  //    in-chunk dedup on top of the LRU cache.
  const re = /[\p{L}']+|[^\p{L}']+/gu;
  type Match = { start: number; end: number; token: string };
  const matches: Match[] = [];
  const uniqueLoanwords = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const chunk = m[0];
    // Word chunk only.
    if (!/^[\p{L}']+$/u.test(chunk)) continue;
    if (!tokenIsLoanword(chunk)) continue;
    matches.push({ start: m.index, end: m.index + chunk.length, token: chunk });
    uniqueLoanwords.add(chunk);
  }

  // Fast path: nothing to wrap → return the ORIGINAL (un-escaped)
  // text so the C++ JNI auto-detect skips the SSML parser entirely.
  if (matches.length === 0) return text;

  // 2. Native phonemize each UNIQUE loanword (uses the LRU cache to
  //    skip already-seen ones from previous chunks).
  const ipaMap = new Map<string, string>();
  for (const tok of uniqueLoanwords) {
    const cacheKey = tok.toLowerCase();
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) {
      ipaMap.set(tok, hit);
      continue;
    }
    let ipa = '';
    try {
      ipa = (await phonemizeFn(tok, 'en-us')) || '';
    } catch {
      ipa = ''; // soft failure — token will fall back to plain text.
    }
    // Trim any leading/trailing whitespace espeak adds, and
    // collapse runs of whitespace to a single space (espeak
    // sometimes adds a final space).
    ipa = ipa.trim().replace(/\s+/g, ' ');
    ipaMap.set(tok, ipa);
    cacheSet(cacheKey, ipa);
  }

  // 3. Second pass — rebuild the string, splicing the SSML wraps in.
  let out = '';
  let cursor = 0;
  for (const { start, end, token } of matches) {
    // Plain text BEFORE this match — XML-escape it.
    if (start > cursor) {
      out += escapeXmlText(text.slice(cursor, start));
    }
    const ipa = ipaMap.get(token) || '';
    if (ipa) {
      // Splice the SSML wrap. The token surface text inside the
      // tag is still XML-escaped (it's regular text content even
      // though espeak's <phoneme> parser ignores it).
      out +=
        `<phoneme alphabet="espeak" ph="${escapeXmlAttribute(ipa)}">` +
        escapeXmlText(token) +
        `</phoneme>`;
    } else {
      // Soft fallback: phonemizer returned nothing → leave the
      // token as plain (escaped) text. The whole sentence will
      // still benefit from any OTHER successful wraps.
      out += escapeXmlText(token);
    }
    cursor = end;
  }
  // Trailing tail.
  if (cursor < text.length) {
    out += escapeXmlText(text.slice(cursor));
  }
  return out;
}
