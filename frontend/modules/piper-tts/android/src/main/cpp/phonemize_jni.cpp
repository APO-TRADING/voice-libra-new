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
  LOGI("nativeInit: dataPath=%s build=v1.0.4-JIT-PHONEME-MAPPING", dataPath.c_str());

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
      // <phoneme alphabet="espeak" ph="PHONEMES">word</phoneme>
      //
      // We inject PHONEMES directly into the output stream WITHOUT any
      // espeak voice switch. This is the v1.0.4 JIT pipeline: the JS
      // layer already pre-computed the English IPA via the dedicated
      // nativePhonemizeAs() entrypoint, so all we need to do here is
      // splice the result in. The current espeak voice stays untouched
      // for the entire sentence → no clause-boundary disruptions.
      //
      // Robust attribute parsing: accept the `ph` attribute in EITHER
      // order (ph="…" alphabet="espeak", OR alphabet="espeak" ph="…").
      // ---------------------------------------------------------------
      size_t phStart = text.find("ph=\"", openTag);
      if (phStart == std::string::npos || phStart > openTag + 64) {
        pos = openTag + 9;  // skip "<phoneme " and resync
        continue;
      }
      phStart += 4;
      size_t phEnd = text.find('"', phStart);
      if (phEnd == std::string::npos) { pos = openTag + 9; continue; }
      std::string phStr = decodeXmlEntities(text.substr(phStart, phEnd - phStart));

      size_t openEnd = text.find('>', phEnd);
      if (openEnd == std::string::npos) { pos = openTag + 9; continue; }
      size_t closeTag = text.find("</phoneme>", openEnd);
      if (closeTag == std::string::npos) closeTag = text.size();

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
