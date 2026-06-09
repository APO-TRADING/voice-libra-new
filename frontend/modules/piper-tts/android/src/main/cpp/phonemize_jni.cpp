// phonemize_jni.cpp
//
// Thin C++ JNI bridge over espeak-ng for the Piper TTS pipeline.
//
// Public Kotlin API:
//   PhonemizerNative.nativeInit(dataPath)              -> 0=OK, <0=err
//   PhonemizerNative.nativeSetVoice(voiceName)         -> 0=OK, <0=err
//   PhonemizerNative.nativePhonemize(text, asIpa)      -> String of phonemes
//   PhonemizerNative.nativePhonemizeAs(text, voice)    -> String of phonemes (JIT 1.0.4)
//   PhonemizerNative.nativeTerminate()                 -> 0=OK
//
// We use the official espeak-ng C API:
//   - espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, ...) we never play audio
//     ourselves, so SYNCHRONOUS+BUFFER mode is what we want — but for pure
//     phonemization we initialize with AUDIO_OUTPUT_SYNCHRONOUS and capture
//     the phoneme output via espeak_TextToPhonemes().
//   - espeak_TextToPhonemes() returns IPA string in caller-allocated buffer.
//   - espeak_SetVoiceByName() switches language ("it", "en", "es", "de", ...).
//
// Threading note: espeak-ng is NOT thread-safe internally. The Kotlin side
// must serialize calls (we use a mutex) when phonemizing in parallel with
// inference. In practice we phonemize sentence-by-sentence on a single
// background coroutine, so this is safe.

#include <jni.h>
#include <android/log.h>
#include <cstring>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>
#include <mutex>

extern "C" {
#include "espeak-ng/speak_lib.h"
}

#define TAG "PiperPhonemize"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

static std::mutex g_mutex;
static bool       g_initialized = false;
// v2.7.7 — remember the last voice the user set via nativeSetVoice() so
// we can switch BACK to it after a per-segment language change during
// SSML phonemization. (espeak_GetCurrentVoice() can return a different
// internal voice after we temporarily set "en" mid-sentence, so we
// can't rely on it — we mirror the truth in this string instead.)
static std::string g_currentVoice;

// Helper: convert a UTF-8 jstring to std::string.
static std::string jstringToString(JNIEnv* env, jstring jstr) {
  if (!jstr) return std::string();
  const char* chars = env->GetStringUTFChars(jstr, nullptr);
  if (!chars) return std::string();
  std::string out(chars);
  env->ReleaseStringUTFChars(jstr, chars);
  return out;
}

// ---------------------------------------------------------------------------
// v1.0.5 — Phoneme stretch helpers.
//
// English phonemes pre-computed by `nativePhonemizeAs(word, "en-us")` and
// spliced into an italian sentence via the `<phoneme alphabet="espeak"
// ph="…" stretch="N">word</phoneme>` SSML tag tend to be rendered ~25%
// faster than the surrounding Italian by Piper VITS — the model is trained
// to Italian prosody and naturally "eats" the foreign sequence.
//
// We compensate by DUPLICATING IPA vowel characters proportionally to the
// stretch factor:
//   stretch 1.00 → no duplication (passthrough)
//   stretch 1.25 → +25% length → 1 vowel out of 4 duplicated
//   stretch 1.50 → +50% length → 1 vowel out of 2 duplicated
//   stretch 2.00 → +100%       → every vowel duplicated
//
// Why vowels: Piper VITS allocates ~70% of the syllable duration to the
// nucleus vowel, so doubling a vowel character is the most direct way to
// stretch the syllable. We DON'T touch consonants (their duration is
// mostly invariant in the VITS duration predictor) or stress markers
// (ˈ ˌ — U+02C8/U+02CC — those are typographical, not durational).
//
// The duplication uses an "accumulator" so the visual effect is even —
// e.g. stretch 1.25 on "ə ɛ ɪ ɔ ʌ" (5 vowels) duplicates exactly 1 of
// them: "ə ɛ ɪ ɪ ɔ ʌ" rather than back-clumping all duplicates at the end.
// ---------------------------------------------------------------------------

// UTF-8 decode of one character starting at s[0]. On success writes the
// Unicode code point to *cp and returns the byte length (1-4). On invalid
// input returns 0 and leaves *cp untouched.
static size_t utf8DecodeOne(const char* s, size_t maxLen, uint32_t* cp) {
  if (maxLen == 0) return 0;
  unsigned char b0 = (unsigned char)s[0];
  if ((b0 & 0x80) == 0) { *cp = b0; return 1; }
  if ((b0 & 0xE0) == 0xC0 && maxLen >= 2) {
    *cp = ((uint32_t)(b0 & 0x1F) << 6)
        |  ((uint32_t)((unsigned char)s[1] & 0x3F));
    return 2;
  }
  if ((b0 & 0xF0) == 0xE0 && maxLen >= 3) {
    *cp = ((uint32_t)(b0 & 0x0F) << 12)
        | ((uint32_t)((unsigned char)s[1] & 0x3F) << 6)
        |  ((uint32_t)((unsigned char)s[2] & 0x3F));
    return 3;
  }
  if ((b0 & 0xF8) == 0xF0 && maxLen >= 4) {
    *cp = ((uint32_t)(b0 & 0x07) << 18)
        | ((uint32_t)((unsigned char)s[1] & 0x3F) << 12)
        | ((uint32_t)((unsigned char)s[2] & 0x3F) << 6)
        |  ((uint32_t)((unsigned char)s[3] & 0x3F));
    return 4;
  }
  return 0;
}

// IPA vowel detector. Covers:
//   - ASCII a/e/i/o/u/y
//   - Latin Extended: æ ø œ
//   - IPA Block (U+0250–U+028F) vowel range
//
// NB: we INTENTIONALLY exclude IPA consonants from the IPA block (e.g.
// ɟ U+025F palatal stop, ɸ U+0278 bilabial fricative). The list below
// is whitelist-only: anything not in it is treated as a non-vowel.
static bool isIpaVowel(uint32_t cp) {
  switch (cp) {
    case 'a': case 'A':
    case 'e': case 'E':
    case 'i': case 'I':
    case 'o': case 'O':
    case 'u': case 'U':
    case 'y': case 'Y':
      return true;
    case 0x00E6: case 0x00C6:  // æ Æ
    case 0x00F8: case 0x00D8:  // ø Ø
    case 0x0153: case 0x0152:  // œ Œ
    case 0x0250:  // ɐ open-mid central unrounded
    case 0x0251:  // ɑ open back unrounded
    case 0x0252:  // ɒ open back rounded
    case 0x0254:  // ɔ open-mid back rounded
    case 0x0259:  // ə schwa
    case 0x025A:  // ɚ rhotic schwa
    case 0x025B:  // ɛ open-mid front unrounded
    case 0x025C:  // ɜ open-mid central unrounded
    case 0x025D:  // ɝ rhotic mid central
    case 0x025E:  // ɞ open-mid central rounded
    case 0x0264:  // ɤ close-mid back unrounded
    case 0x0268:  // ɨ close central unrounded
    case 0x026A:  // ɪ near-close near-front unrounded
    case 0x026F:  // ɯ close back unrounded
    case 0x0275:  // ɵ close-mid central rounded
    case 0x0276:  // ɶ open front rounded
    case 0x0279:  // ɹ approximant — NOT vowel, but often acts like one
                  // in syllabic position. We keep it OUT to be safe.
                  // (Listed here for documentation only — return false.)
      return cp != 0x0279;
    case 0x0289:  // ʉ close central rounded
    case 0x028A:  // ʊ near-close near-back rounded
    case 0x028C:  // ʌ open-mid back unrounded
    case 0x028F:  // ʏ near-close near-front rounded
      return true;
    default:
      return false;
  }
}

// Returns a stretched copy of `ipa` (UTF-8). If `factor` <= 1.0 the input
// is returned unchanged (zero-copy fast path).
//
// Algorithm:
//   - extra = factor - 1.0   (fraction of vowels to duplicate)
//   - walk the string utf-8-character by utf-8-character
//   - emit every character once
//   - if the character is an IPA vowel, accumulate `extra` into a
//     counter; whenever the counter >= 1.0, emit the vowel ONE more
//     time and decrement the counter. This produces an even spread
//     of duplicates (no end-clumping).
//
// Examples (stretch = 1.25, extra = 0.25):
//   "ə"           → "ə"        (counter 0.25 < 1, no dup)
//   "ə ɛ ɪ ɔ"     → "ə ɛ ɪ ɪ ɔ" (4 vowels, counter reaches 1.0 at the 4th
//                                vowel ɪ — duplicated; counter back to 0)
//   "ɡ l ˈɒ k"    → "ɡ l ˈɒ k"  (1 vowel only, counter 0.25 < 1, no dup)
//   "ɡ l ˈɒ k ə"  → "ɡ l ˈɒ k ə" (2 vowels, counter 0.50 < 1, no dup)
//   Stretching only really starts mattering for words with >= 4 vowels,
//   which is fine — short words don't suffer the duration mismatch.
static std::string stretchIpaVowels(const std::string& ipa, double factor) {
  if (factor <= 1.0 || ipa.empty()) return ipa;
  // Cap to avoid pathological inputs (defensive).
  if (factor > 3.0) factor = 3.0;
  const double extraPerVowel = factor - 1.0;
  std::string out;
  out.reserve((size_t)(ipa.size() * (factor + 0.1)));
  double accumulator = 0.0;
  size_t i = 0;
  int dupCount = 0;
  while (i < ipa.size()) {
    uint32_t cp = 0;
    size_t len = utf8DecodeOne(ipa.c_str() + i, ipa.size() - i, &cp);
    if (len == 0) {
      // Malformed UTF-8 byte — copy as-is and advance 1 byte to recover.
      out.push_back(ipa[i]);
      i += 1;
      continue;
    }
    // Always emit the character.
    out.append(ipa, i, len);
    if (isIpaVowel(cp)) {
      accumulator += extraPerVowel;
      while (accumulator >= 1.0) {
        out.append(ipa, i, len);  // duplicate the vowel
        accumulator -= 1.0;
        dupCount += 1;
      }
    }
    i += len;
  }
  if (dupCount > 0) {
    LOGI("stretchIpaVowels: factor=%.2f in=%zuB out=%zuB dup=%d",
         factor, ipa.size(), out.size(), dupCount);
  }
  return out;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_beppeaudiobooks_pipertts_PhonemizerNative_nativeInit(
    JNIEnv* env, jclass, jstring jDataPath) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (g_initialized) {
    LOGI("nativeInit: already initialized, returning 0");
    return 0;
  }
  std::string dataPath = jstringToString(env, jDataPath);
  // v1.0.4 build fingerprint — grep this in adb logcat to verify the
  // running .so was compiled FROM this source revision (and not from
  // a stale EAS cache layer). If you don't see it, the cached build
  // is being used and the SSML auto-detect patch may not be present.
  // v1.0.4 marker confirms the JIT Phoneme-Mapping pipeline is live:
  // <phoneme alphabet="espeak" ph="…">word</phoneme> is supported and
  // the new nativePhonemizeAs() JNI entrypoint is exposed.
  LOGI("nativeInit: dataPath=%s build=v1.0.5-PHONEME-STRETCH", dataPath.c_str());

  // AUDIO_OUTPUT_RETRIEVAL means we won't actually output audio — we only
  // need espeak to compute phonemes. Buffer length is in ms (zero means
  // use default — irrelevant since we don't play audio).
  int sampleRate = espeak_Initialize(
      AUDIO_OUTPUT_RETRIEVAL,
      /*buflength=*/0,
      /*path=*/dataPath.empty() ? nullptr : dataPath.c_str(),
      /*options=*/0);

  if (sampleRate < 0) {
    LOGE("espeak_Initialize failed: %d", sampleRate);
    return -1;
  }

  g_initialized = true;
  LOGI("espeak_Initialize OK, sampleRate=%d", sampleRate);
  return 0;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_beppeaudiobooks_pipertts_PhonemizerNative_nativeSetVoice(
    JNIEnv* env, jclass, jstring jVoice) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_initialized) {
    LOGE("nativeSetVoice called before nativeInit");
    return -1;
  }
  std::string voice = jstringToString(env, jVoice);
  if (voice.empty()) voice = "it";
  espeak_ERROR err = espeak_SetVoiceByName(voice.c_str());
  if (err != EE_OK) {
    LOGE("espeak_SetVoiceByName(%s) -> %d", voice.c_str(), err);
    return -2;
  }
  // v2.7.7 — keep the truth so we can restore it after a temporary
  // per-segment switch during SSML phonemize.
  g_currentVoice = voice;
  LOGI("voice set to %s", voice.c_str());
  return 0;
}

// ---------------------------------------------------------------------------
// Helper: phonemize a SINGLE plain-text segment with the CURRENT espeak voice.
// Used both for non-SSML inputs and for each segment of an SSML-parsed input
// after the voice has been temporarily switched.
// ---------------------------------------------------------------------------
static std::string phonemizePlainSegment(const std::string& seg) {
  if (seg.empty()) return "";
  // Internal espeak-ng clause-type constants (from src/libespeak-ng/translate.h
  // at the pinned commit). Lower 20 bits encode the punctuation kind.
  static constexpr int CLAUSE_TYPE_MASK    = 0x000FFFFF;
  static constexpr int CLAUSE_PERIOD       = 40 | 0x00000000 | 0x00080000;
  static constexpr int CLAUSE_COMMA        = 20 | 0x00001000 | 0x00040000;
  static constexpr int CLAUSE_QUESTION     = 40 | 0x00002000 | 0x00080000;
  static constexpr int CLAUSE_EXCLAMATION  = 45 | 0x00003000 | 0x00080000;
  static constexpr int CLAUSE_COLON        = 30 | 0x00000000 | 0x00040000;
  static constexpr int CLAUSE_SEMICOLON    = 30 | 0x00001000 | 0x00040000;

  const void* textPtr = seg.c_str();
  std::string result;
  while (textPtr != nullptr) {
    int terminator = 0;
    const char* chunk = espeak_TextToPhonemesWithTerminator(
        &textPtr,
        /*textmode=*/espeakCHARS_UTF8,
        /*phonememode=*/0x02,
        &terminator);
    if (chunk && *chunk) {
      result.append(chunk);
    }
    int punct = terminator & CLAUSE_TYPE_MASK;
    if (punct == CLAUSE_PERIOD)            result.push_back('.');
    else if (punct == CLAUSE_QUESTION)     result.push_back('?');
    else if (punct == CLAUSE_EXCLAMATION)  result.push_back('!');
    else if (punct == CLAUSE_COMMA)        { result.push_back(','); result.push_back(' '); }
    else if (punct == CLAUSE_COLON)        { result.push_back(':'); result.push_back(' '); }
    else if (punct == CLAUSE_SEMICOLON)    { result.push_back(';'); result.push_back(' '); }
  }
  return result;
}

// Helper: decode the three XML entities our JS pre-processor emits.
// We MUST do this AFTER segmenting out the SSML tags, so the literal
// characters end up inside plain segments that go to espeak.
static std::string decodeXmlEntities(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  for (size_t i = 0; i < s.size(); ) {
    if (s[i] == '&') {
      if (s.compare(i, 4, "&lt;") == 0)   { out += '<'; i += 4; continue; }
      if (s.compare(i, 4, "&gt;") == 0)   { out += '>'; i += 4; continue; }
      if (s.compare(i, 5, "&amp;") == 0)  { out += '&'; i += 5; continue; }
      if (s.compare(i, 6, "&quot;") == 0) { out += '"'; i += 6; continue; }
      if (s.compare(i, 6, "&apos;") == 0) { out += '\''; i += 6; continue; }
    }
    out += s[i++];
  }
  return out;
}

// Returns the IPA-phoneme string produced by espeak for the given text.
// Sentences are separated by spaces. Stress markers (ˈ, ˌ) are preserved.
// Punctuation markers (. , ? ! : ;) are re-injected into the stream at
// clause boundaries — espeak normally STRIPS them from the phoneme
// output, but Piper VITS models are TRAINED with these tokens (they
// drive the model's prosody, intonation, and pause timing). The exact
// algorithm matches rhasspy/piper-phonemize's phonemize_eSpeak().
//
// v1.0.4-JIT-PHONEME-MAPPING — the parser now ALSO recognizes the SSML
// tag <phoneme alphabet="espeak" ph="…">word</phoneme> emitted by the
// JS JIT pre-processor (see frontend/src/audio/foreignWords.ts). When
// found, the contents of `ph` are written DIRECTLY into the output
// phoneme stream (no espeak voice switch), and the word's surface text
// is dropped. This eliminates the stop-and-start artifacts caused by
// per-loanword <voice name="en"> switches in v2.7.7. The legacy
// <voice>…</voice> path is kept for backwards compatibility and as a
// safety-net fallback (zero runtime cost when not used).
//
// WHY THIS ARCHITECTURE WINS:
//   With the JIT JS pipeline pre-computing the English phonemes for
//   each foreign word, we feed espeak ONE continuous Italian sentence
//   that *already contains* English phonemes baked-in for the target
//   words. espeak makes a SINGLE prosody pass over the text — no
//   voice resets, no clause boundary disruptions inside loanwords —
//   so Piper VITS receives a smooth, italian-prosodic stream that
//   merely happens to contain English-phonetic islands. The audio
//   the user hears is one continuous Italian sentence with naturally
//   pronounced English loanwords inside it.
extern "C" JNIEXPORT jstring JNICALL
Java_com_beppeaudiobooks_pipertts_PhonemizerNative_nativePhonemize(
    JNIEnv* env, jclass, jstring jText) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_initialized) {
    LOGE("nativePhonemize called before nativeInit");
    return env->NewStringUTF("");
  }
  std::string text = jstringToString(env, jText);
  if (text.empty()) return env->NewStringUTF("");

  // Fast path: no SSML markup at all → just phonemize as-is. This is
  // the ~99% case (toggle OFF, or src lang is `en`, or no loanword
  // matched).
  const bool hasVoiceTag   = (text.find("<voice ")   != std::string::npos);
  const bool hasPhonemeTag = (text.find("<phoneme ") != std::string::npos);
  if (!hasVoiceTag && !hasPhonemeTag) {
    std::string out = phonemizePlainSegment(decodeXmlEntities(text));
    return env->NewStringUTF(out.c_str());
  }

  // SSML path. The JS pre-processor (foreignWords.ts) emits either of:
  //   • `<voice name="LANG">INNER</voice>` (legacy v2.7.7, fallback)
  //   • `<phoneme alphabet="espeak" ph="PHONEMES">WORD</phoneme>` (JIT v1.0.4)
  // Both are well-formed (no nesting, balanced tags, no whitespace
  // inside the open tag). We still defend against malformed input by
  // skipping any tag we can't parse.
  LOGI("nativePhonemize: SSML pipeline engaged, len=%zu, baseVoice=%s, hasVoiceTag=%d, hasPhonemeTag=%d",
       text.size(), g_currentVoice.c_str(), (int)hasVoiceTag, (int)hasPhonemeTag);

  const std::string baseVoice = g_currentVoice;  // remember so we can restore
  std::string activeVoice     = baseVoice;       // mirror espeak's actual state
  std::string result;
  size_t pos = 0;

  while (pos < text.size()) {
    // Find the NEXT SSML opener — whichever comes first between
    // `<voice ` and `<phoneme `.
    size_t openVoice   = text.find("<voice ",   pos);
    size_t openPhoneme = text.find("<phoneme ", pos);
    size_t openTag     = std::min(openVoice, openPhoneme);
    bool isPhoneme = (openTag == openPhoneme && openPhoneme != std::string::npos);

    // --- Outer (no-switch) segment: from pos up to openTag (or end). ---
    size_t outerEnd = (openTag == std::string::npos) ? text.size() : openTag;
    if (outerEnd > pos) {
      // Restore the base voice if we drifted away in the previous loop.
      if (activeVoice != baseVoice && !baseVoice.empty()) {
        espeak_SetVoiceByName(baseVoice.c_str());
        activeVoice = baseVoice;
      }
      std::string outer = decodeXmlEntities(text.substr(pos, outerEnd - pos));
      result += phonemizePlainSegment(outer);
    }
    if (openTag == std::string::npos) break;

    if (isPhoneme) {
      // ---------------------------------------------------------------
      // <phoneme alphabet="espeak" ph="PHONEMES" stretch="N">word</phoneme>
      //
      // We inject PHONEMES directly into the output stream WITHOUT any
      // espeak voice switch. This is the v1.0.4 JIT pipeline: the JS
      // layer already pre-computed the English IPA via the dedicated
      // nativePhonemizeAs() entrypoint, so all we need to do here is
      // splice the result in. The current espeak voice stays untouched
      // for the entire sentence → no clause-boundary disruptions.
      //
      // v1.0.5 — the optional `stretch="N"` attribute (typical N=1.25)
      // tells us to slow down the inner IPA sequence so the foreign
      // word doesn't get visually "eaten" by Piper's Italian-trained
      // duration predictor. We implement the slowdown by duplicating
      // IPA vowel characters proportionally to the stretch factor
      // (see stretchIpaVowels() at top of file for the algorithm).
      //
      // Robust attribute parsing: `ph` and `stretch` may appear in
      // any order inside the open tag.
      // ---------------------------------------------------------------
      // Locate the end of the open tag first so attribute searches
      // can't run past it (defensive).
      size_t openEnd = text.find('>', openTag);
      if (openEnd == std::string::npos) { pos = openTag + 9; continue; }
      const std::string openTagContent = text.substr(openTag, openEnd - openTag);
      // Parse ph="…"
      size_t phStart = openTagContent.find("ph=\"");
      if (phStart == std::string::npos) {
        pos = openTag + 9;  // skip "<phoneme " and resync
        continue;
      }
      phStart += 4;
      size_t phEnd = openTagContent.find('"', phStart);
      if (phEnd == std::string::npos) { pos = openTag + 9; continue; }
      std::string phStr = decodeXmlEntities(openTagContent.substr(phStart, phEnd - phStart));
      // Parse stretch="…" (OPTIONAL). Default 1.0 = no stretch.
      double stretch = 1.0;
      size_t stStart = openTagContent.find("stretch=\"");
      if (stStart != std::string::npos) {
        stStart += 9;
        size_t stEnd = openTagContent.find('"', stStart);
        if (stEnd != std::string::npos) {
          std::string stStr = openTagContent.substr(stStart, stEnd - stStart);
          try {
            stretch = std::stod(stStr);
          } catch (...) { stretch = 1.0; }
          // Sanity clamp — anything outside [1.0, 3.0] is ignored.
          if (stretch < 1.0 || stretch > 3.0 || !(stretch == stretch)) {  // NaN check
            stretch = 1.0;
          }
        }
      }

      size_t closeTag = text.find("</phoneme>", openEnd);
      if (closeTag == std::string::npos) closeTag = text.size();

      // Apply v1.0.5 stretch (vowel duplication).
      if (stretch > 1.0 && !phStr.empty()) {
        std::string stretched = stretchIpaVowels(phStr, stretch);
        if (!stretched.empty()) phStr = stretched;
      }

      // Insert the pre-computed phonemes. Pad with a single space on
      // each side so the espeak prosody on the next plain segment
      // treats the injection as a separate word, preserving stress
      // boundaries between IT phonemes and EN phonemes.
      if (!phStr.empty()) {
        if (!result.empty() && result.back() != ' ') result.push_back(' ');
        result += phStr;
        result.push_back(' ');
      }

      pos = (closeTag == text.size()) ? text.size() : (closeTag + 10);  // strlen("</phoneme>") == 10
      continue;
    }

    // ---------------------------------------------------------------
    // <voice name="LANG">INNER</voice>  (legacy v2.7.7 path)
    //
    // Kept for backwards compat & fallback testing only — the new JIT
    // pipeline doesn't emit this tag anymore. Per-segment voice switch:
    // costly (full espeak translator reset) and source of the audible
    // micro-stops the v1.0.4 refactor was designed to eliminate.
    // ---------------------------------------------------------------
    size_t nameStart = text.find("name=\"", openTag);
    if (nameStart == std::string::npos || nameStart > openTag + 32) {
      pos = openTag + 7;  // skip "<voice " and resync
      continue;
    }
    nameStart += 6;
    size_t nameEnd = text.find('"', nameStart);
    if (nameEnd == std::string::npos) { pos = openTag + 7; continue; }
    std::string segVoice = text.substr(nameStart, nameEnd - nameStart);
    size_t openEnd = text.find('>', nameEnd);
    if (openEnd == std::string::npos) { pos = openTag + 7; continue; }
    size_t closeTag = text.find("</voice>", openEnd);
    if (closeTag == std::string::npos) {
      // Unclosed tag — treat the rest as a single inner segment.
      closeTag = text.size();
    }
    // Inner segment between '>' and '</voice>'.
    std::string inner = decodeXmlEntities(
        text.substr(openEnd + 1, closeTag - openEnd - 1));

    if (!inner.empty()) {
      if (segVoice != activeVoice) {
        if (espeak_SetVoiceByName(segVoice.c_str()) == EE_OK) {
          activeVoice = segVoice;
        } else {
          LOGE("nativePhonemize: SetVoiceByName(%s) failed, keeping %s",
               segVoice.c_str(), activeVoice.c_str());
        }
      }
      result += phonemizePlainSegment(inner);
    }
    // Advance past the close tag (or to EOF if unclosed).
    pos = (closeTag == text.size()) ? text.size() : (closeTag + 8);
  }

  // --- Restore the base voice so subsequent unrelated calls are unaffected. ---
  if (activeVoice != baseVoice && !baseVoice.empty()) {
    espeak_SetVoiceByName(baseVoice.c_str());
  }
  return env->NewStringUTF(result.c_str());
}

// ---------------------------------------------------------------------------
// v1.0.4 — JIT phonemize entrypoint.
//
// Phonemize the given text WITH AN ARBITRARY VOICE (typically "en-us"
// for English loanwords) and RESTORE the previously-set voice on exit.
//
// This is the bridge the JS layer uses to pre-compute the IPA string
// for each foreign word BEFORE wrapping it in `<phoneme ph="…">…
// </phoneme>` SSML. Crucially, it does NOT alter g_currentVoice — the
// caller's view of "which voice is set" stays intact, because the
// voice switch is reverted before this function returns.
//
// Threading: takes the SAME mutex as nativePhonemize() / nativeSetVoice(),
// so even concurrent calls from JS will serialize correctly. In practice
// the JS pre-buffer pipeline calls this 0-5 times per chunk on the same
// background thread, so contention is non-existent.
//
// Edge cases:
//   - g_initialized==false   → returns "" (caller falls back to plain text)
//   - voice empty/unknown    → returns "" (espeak SetVoiceByName fails)
//   - text empty             → returns "" (no work to do)
//   - espeak voice restore   → best-effort; if it fails we log but still
//     return the phonemes (caller's next nativePhonemize() will retry)
// ---------------------------------------------------------------------------
extern "C" JNIEXPORT jstring JNICALL
Java_com_beppeaudiobooks_pipertts_PhonemizerNative_nativePhonemizeAs(
    JNIEnv* env, jclass, jstring jText, jstring jVoice) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_initialized) {
    LOGE("nativePhonemizeAs called before nativeInit");
    return env->NewStringUTF("");
  }
  std::string text  = jstringToString(env, jText);
  std::string voice = jstringToString(env, jVoice);
  if (text.empty() || voice.empty()) return env->NewStringUTF("");

  const std::string baseVoice = g_currentVoice;
  // Switch to the requested voice.
  espeak_ERROR err = espeak_SetVoiceByName(voice.c_str());
  if (err != EE_OK) {
    LOGE("nativePhonemizeAs: SetVoiceByName(%s) failed err=%d", voice.c_str(), err);
    // No-op restore needed since the switch failed.
    return env->NewStringUTF("");
  }

  // Phonemize the (already-decoded — no XML expected here) text.
  std::string out = phonemizePlainSegment(text);

  // Best-effort restore of the user-set voice. If it fails we log
  // and keep going; subsequent nativePhonemize() calls will re-set
  // the voice on the first <voice> segment they encounter, and the
  // outer Kotlin code re-issues SetVoiceByName at every loadVoice().
  if (!baseVoice.empty()) {
    espeak_ERROR restoreErr = espeak_SetVoiceByName(baseVoice.c_str());
    if (restoreErr != EE_OK) {
      LOGE("nativePhonemizeAs: restore SetVoiceByName(%s) failed err=%d",
           baseVoice.c_str(), restoreErr);
    }
  }

  LOGI("nativePhonemizeAs: voice=%s text=\"%.*s\" -> ipa=\"%s\" (%zuB)",
       voice.c_str(),
       (int)std::min<size_t>(text.size(), 40), text.c_str(),
       out.c_str(), out.size());
  return env->NewStringUTF(out.c_str());
}

extern "C" JNIEXPORT jint JNICALL
Java_com_beppeaudiobooks_pipertts_PhonemizerNative_nativeTerminate(
    JNIEnv*, jclass) {
  std::lock_guard<std::mutex> lock(g_mutex);
  if (!g_initialized) return 0;
  espeak_Terminate();
  g_initialized = false;
  LOGI("espeak_Terminate done");
  return 0;
}
