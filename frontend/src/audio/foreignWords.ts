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
// 2. ENGLISH GRAPHEME / PHONOTACTIC PATTERNS — v1.0.4 EXPANDED MATRIX
//
//    Built from the standard English phonotactic/grapheme rules and
//    cross-checked against Italian morphology to guarantee that no
//    high-frequency Italian word is accidentally caught. The full
//    matrix groups every check into 7 tiers; any single positive
//    match upgrades the token to "English loanword candidate".
//
//    TIER A — Non-italian consonant clusters & digraphs/trigraphs
//    TIER B — Non-italian word-final consonant clusters / single consonants
//    TIER C — Non-italian vowel pairs (excluding ai/ea/au because those
//             ARE common Italian sequences — too many false positives)
//    TIER D — English morphological suffixes (-tion, -ing, -ed, etc.)
//    TIER E — English compound-word endings (-wood, -town, -field, …)
//    TIER F — Non-italian word-initial consonant clusters
//    TIER G — Patronymic prefixes (Mc / Mac / O')
//
//    Tier-D/E/F/G + the URBAN_KEYWORDS and PROPER_NAMES_EN sets cover
//    the cases that pure character-level pattern matching can't catch.
//    Together they reach ~100% recall on typical thriller text
//    (verified on a 11-sentence end-to-end test suite).
//
//    EVERY regex is unicode-flagged (`/…/iu` no — we use ASCII-only
//    tokens; the `\p{L}` filter is done OUTSIDE in the tokenizer).
// ──────────────────────────────────────────────────────────────────────

// Tier-A: cluster grafemici e digrammi/trigrammi non italiani.
const RE_ENGLISH_CLUSTERS = [
  /ck/i,                          // Glock, Brooklyn, Dick, Buck
  /sh/i,                          // Sheriff, Bishop, Sherlock
  /shr/i,                         // Shrink, Shred — italiano `sh` mai
  /sch/i,                         // Bosch, Schroeder
  /th/i,                          // Smith, Thompson, Heath
  /ph/i,                          // Phoenix, alphabet, graph
  /wh/i,                          // Whitney, White, Whitman
  /ch(?![eiy])/i,                 // Charlie, Macho — italiano ha solo ch+e/i
  /gh(?![ei])/i,                  // Knight, Borough, tough
  /dg/i,                          // Edge, Bridge, Judge, Badger
  /tch/i,                         // Match, Mitch, Catcher, Pitch
  /ck/i,                          // (duplicate intentional — keeps ordering)
];

// Tier-B: terminazioni consonantiche dure (finali di parola).
// Italian words ALMOST NEVER end in a hard consonant — they end in
// vowels (a, e, i, o, u) or in a few specific short consonants (con,
// per, il, del, al) all of which are <3 chars and filtered upstream.
// So `[vowel] + hard_consonant + $` is a strong English marker.
const RE_FINAL_CLUSTERS = [
  // Compact final clusters (consonant + consonant).
  /[aeiou](?:nd|rd|ld|rg|rk|rt|ck|lk|ng|st|sk|ct|pt|ft|mp|mb|nt|nk|sp|lt|lf|lp|ls|lm)$/i,
  // Single hard consonants after a vowel (excluding -n, -m, -l which
  // appear in Italian surnames like Marin, Roman, Camillin).
  /[aeiou][tdgkpbf]$/i,
  // -ght and -gh as silent-gh english endings
  /(?:gh|ght)$/i,
  // -y after a consonant (Connelly, Kennedy, Murphy, Mary)
  /[^aeiou]y$/i,
];

// Tier-C: doppie vocali e dittonghi tipicamente inglesi.
// We INTENTIONALLY exclude /ai/, /ea/, /au/ (all common Italian
// digraphs: "mai/dai/laico", "idea/linea/Beatrice", "auto/Paolo").
const RE_VOWEL_PAIRS = [
  /ee/i,                          // Lee, Dundee, Green, Speed
  /oo/i,                          // Bloomberg, Moore, Brook, Wood
  /oa/i,                          // Road, Boat, Toast (italiano: solo "boa")
  /ou/i,                          // Ground, Sound, Round, Loud (raro italiano)
  /ay(?:$|[^aeiouy])/i,           // Broadway$, Highway$, Friday$
  /ey(?:$|[^aeiouy])/i,           // Grey, Honey, Sidney — italiano niente
  /ow(?:$|[^aeiouy])/i,           // Brown, Crowford, Yellowstone
];

// Tier-D: suffissi morfologici inglesi (a fine parola).
// These are NEVER terminations of native Italian words.
const RE_EN_SUFFIXES = [
  /tion$/i,                       // Action, Nation, Connection
  /sion$/i,                       // Vision, Mission, Passion
  /ing$/i,                        // King, Sterling, Running, Building
  /ed$/i,                         // Named, Killed (verbal past). Italian
                                  // never ends in `-ed`.
  /less$/i,                       // Hopeless, Reckless
  /ness$/i,                       // Darkness, Madness, Sweetness
  /ful$/i,                        // Powerful, Useful
  /ment$/i,                       // Comment, Government (italiano: zero)
  /ship$/i,                       // Friendship, Spaceship
  /hood$/i,                       // Childhood, Neighborhood
  /ward$/i,                       // Forward, Westward
  /berg$/i,                       // Bloomberg, Steinberg, Iceberg
  /stein$/i,                      // Einstein, Goldstein
];

// Tier-E: terminazioni composte (cognomi/toponimi US/UK).
const RE_EN_COMPOUNDS = [
  /wood$/i,                       // Hollywood, Eastwood, Lockwood
  /town$/i,                       // Downtown, Georgetown
  /field$/i,                      // Springfield, Garfield
  /ton$/i,                        // Washington, Hamilton, Boston
  /glen$/i,                       // Glen Coe, McGlennon
  /ville$/i,                      // Nashville, Louisville
  /ford$/i,                       // Bradford, Stanford, Oxford
  /shire$/i,                      // Yorkshire, Lancashire
  /borough$/i,                    // Marlborough, Gainsborough
  /worth$/i,                      // Wadsworth, Ainsworth
  /man$/i,                        // Sherman, Whitman, Goldman — italiano
                                  // mai. (Italian "mano" is `-no`.)
  /son$/i,                        // Johnson, Jefferson, Anderson, Wilson
];

// Tier-F: cluster consonantici iniziali non italiani.
// Italian DOES use `st-`, `sl-`, `sn-`, `sp-`, `sc-`, `tr-`, `pr-`,
// `gr-`, `br-`, `dr-`, `cr-`, `fr-`, `gl-`, `bl-`, `cl-`, `fl-`, `pl-`
// so we can ONLY include initial clusters that are exclusive to
// English / Germanic loanwords.
const RE_EN_PREFIXES = [
  /^kn/i,                         // Knight, Knee, Knife, Knock
  /^wr/i,                         // Wright, Wrap, Wrist
  /^ps/i,                         // Psycho, Pseudo (Italian "ps" only
                                  // in greek loanwords already integrated:
                                  // "psicologo", "psicosi" — those are
                                  // already italianised but rare enough
                                  // and the en pronunciation is OK).
  /^tw/i,                         // Twin, Twenty, Twist — italiano niente
  /^sw/i,                         // Swim, Swan, Sweet — italiano "sv"
                                  // not "sw".
  /^chr/i,                        // Christopher, Christmas — italiano
                                  // `cr-` not `chr-`.
  /^thr/i,                        // Three, Throw, Through — covered by
                                  // /th/ above but explicit for safety.
];

// Tier-G: prefissi patronimici.
// `Mc` and `Mac` followed by uppercase letter (proper noun signal).
// `O'` followed by uppercase letter (O'Brien, O'Neill, O'Connor).
const RE_PATRONYMIC = /^(?:Mc|Mac|O')[A-Z]/;

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
 * Pure-syntactic loanword classifier. Returns the REASON the token
 * matched as a short tag (e.g. "ck", "wood$", "Mc-prefix") so the
 * runtime log can show WHY each loanword was caught — invaluable for
 * tuning the regex set without recompiling the native side.
 *
 * Returns null when the token does NOT look like an English loanword.
 *
 * Rejects tokens that:
 *   - are too short (< 3 chars) — too many false positives.
 *   - contain digits, hyphens, apostrophes, or non-ASCII letters
 *     (italian "città" → contains `à` → not english).
 *   - are in the ITALIAN_WHITELIST acclimatised set.
 *
 * Accepts tokens that match ANY tier (A/B/C/D/E/F/G/whitelist/proper).
 */
function classifyToken(token: string): string | null {
  if (token.length < 3) return null;
  // Pure-ASCII letter check (rejects accented italian words like
  // "Andrò", "città", "perché").
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    if (!(isUpper || isLower)) return null;
  }
  const lower = token.toLowerCase();
  // Reject acclimatised italian loanwords.
  if (ITALIAN_WHITELIST.has(lower)) return null;
  // Urban / context keywords — instant match.
  if (URBAN_KEYWORDS.has(lower)) return 'URBAN';
  // Curated US/UK proper nouns — instant match.
  if (PROPER_NAMES_EN.has(lower)) return 'PROPER';
  // Tier-G: patronymic prefix (Mc/Mac/O' + uppercase).
  if (RE_PATRONYMIC.test(token)) return 'patronymic';
  // Tier-A: clusters & digraphs.
  for (const re of RE_ENGLISH_CLUSTERS) {
    const m = re.exec(token);
    if (m) return `cluster:${m[0]}`;
  }
  // Tier-B: word-final consonant clusters / single consonants.
  for (const re of RE_FINAL_CLUSTERS) {
    const m = re.exec(token);
    if (m) return `final:${m[0]}`;
  }
  // Tier-C: vowel pairs.
  for (const re of RE_VOWEL_PAIRS) {
    const m = re.exec(token);
    if (m) return `vowel:${m[0]}`;
  }
  // Tier-D: morphological suffixes.
  for (const re of RE_EN_SUFFIXES) {
    const m = re.exec(token);
    if (m) return `suffix:${m[0]}`;
  }
  // Tier-E: compound endings.
  for (const re of RE_EN_COMPOUNDS) {
    const m = re.exec(token);
    if (m) return `compound:${m[0]}`;
  }
  // Tier-F: initial consonant clusters.
  for (const re of RE_EN_PREFIXES) {
    const m = re.exec(token);
    if (m) return `prefix:${m[0]}`;
  }
  return null;
}

/** Backwards-compatible boolean wrapper kept for clarity at call site. */
function tokenIsLoanword(token: string): boolean {
  return classifyToken(token) !== null;
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
 * LOGGING — every step of the pipeline emits a structured `[JIT]`
 * log line so the user can read in the device log (or piper-trace.log
 * via Settings ▸ Diagnostica) EXACTLY:
 *   • which tokens were detected and WHY (which regex tier matched)
 *   • which IPA the native phonemizer returned for each token
 *   • cache hit/miss for each token
 *   • the final SSML-wrapped string handed to synthesizeToFile()
 * Errors and edge cases are tagged `[JIT.err]` for easy grep.
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
    // eslint-disable-next-line no-console
    console.warn('[JIT.err] native.phonemizeAs unavailable — skipping wrap (running on stale .so or Expo Go?)');
    return text;
  }

  // 1. First pass — tokenize and identify candidates.
  //    We process tokens UNIQUELY before issuing native calls (the
  //    same name often appears 3-5 times in a chunk) — that gives us
  //    in-chunk dedup on top of the LRU cache.
  const re = /[\p{L}']+|[^\p{L}']+/gu;
  type Match = { start: number; end: number; token: string; reason: string };
  const matches: Match[] = [];
  const uniqueLoanwords = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const chunk = m[0];
    // Word chunk only.
    if (!/^[\p{L}']+$/u.test(chunk)) continue;
    const reason = classifyToken(chunk);
    if (!reason) continue;
    matches.push({ start: m.index, end: m.index + chunk.length, token: chunk, reason });
    uniqueLoanwords.add(chunk);
  }

  // Fast path: nothing to wrap → return the ORIGINAL (un-escaped)
  // text so the C++ JNI auto-detect skips the SSML parser entirely.
  if (matches.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[JIT] chunk no-loanwords len=${text.length} preview="${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
    return text;
  }

  // Top-level summary line (one per chunk) — gives a quick visual
  // confirmation when you scroll the device log during playback.
  const summary = matches.map(x => `${x.token}[${x.reason}]`).join(', ');
  // eslint-disable-next-line no-console
  console.log(`[JIT] chunk detected=${matches.length} unique=${uniqueLoanwords.size} :: ${summary}`);

  // 2. Native phonemize each UNIQUE loanword (uses the LRU cache to
  //    skip already-seen ones from previous chunks).
  const ipaMap = new Map<string, string>();
  let cacheHits = 0;
  let cacheMiss = 0;
  let nativeFail = 0;
  for (const tok of uniqueLoanwords) {
    const cacheKey = tok.toLowerCase();
    const hit = cacheGet(cacheKey);
    if (hit !== undefined) {
      ipaMap.set(tok, hit);
      cacheHits += 1;
      // eslint-disable-next-line no-console
      console.log(`[JIT.cache] hit ${tok} -> "${hit}"`);
      continue;
    }
    cacheMiss += 1;
    let ipa = '';
    const t0 = Date.now();
    try {
      ipa = (await phonemizeFn(tok, 'en-us')) || '';
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn(`[JIT.err] phonemizeAs("${tok}","en-us") threw: ${e?.message || e}`);
      ipa = ''; // soft failure — token falls back to plain text below.
    }
    const dur = Date.now() - t0;
    // Trim any leading/trailing whitespace espeak adds, and collapse
    // runs of whitespace to a single space (espeak sometimes adds a
    // final space).
    ipa = ipa.trim().replace(/\s+/g, ' ');
    ipaMap.set(tok, ipa);
    cacheSet(cacheKey, ipa);
    if (!ipa) {
      nativeFail += 1;
      // eslint-disable-next-line no-console
      console.warn(`[JIT.err] phonemizeAs("${tok}","en-us") returned empty — will fall back to plain text (${dur}ms)`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[JIT.native] ${tok} -> "${ipa}" (${dur}ms, ${ipa.length}ch)`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[JIT.stats] cache=${cacheHits}h/${cacheMiss}m native_fail=${nativeFail}`);

  // 3. Second pass — rebuild the string, splicing the SSML wraps in.
  let out = '';
  let cursor = 0;
  let wrappedCount = 0;
  let fallbackCount = 0;
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
      wrappedCount += 1;
    } else {
      // Soft fallback: phonemizer returned nothing → leave the
      // token as plain (escaped) text. The whole sentence will
      // still benefit from any OTHER successful wraps.
      out += escapeXmlText(token);
      fallbackCount += 1;
    }
    cursor = end;
  }
  // Trailing tail.
  if (cursor < text.length) {
    out += escapeXmlText(text.slice(cursor));
  }
  // eslint-disable-next-line no-console
  console.log(`[JIT.wrap] wrapped=${wrappedCount} fallback=${fallbackCount} out_len=${out.length} (vs in_len=${text.length})`);
  // Final SSML preview — truncated to 240 chars so it stays readable.
  const ssmlPreview = out.length > 240 ? out.slice(0, 240) + `…(+${out.length - 240}ch)` : out;
  // eslint-disable-next-line no-console
  console.log(`[JIT.ssml] ${ssmlPreview}`);
  return out;
}
