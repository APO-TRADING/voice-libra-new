// phonemize_jni.cpp
//
// Thin C++ JNI bridge over espeak-ng for the Piper TTS pipeline.
//
// Public Kotlin API:
//   PhonemizerNative.nativeInit(dataPath)            -> 0=OK, <0=err
//   PhonemizerNative.nativeSetVoice(voiceName)       -> 0=OK, <0=err
//   PhonemizerNative.nativePhonemize(text, asIpa)    -> String of phonemes
//   PhonemizerNative.nativeTerminate()               -> 0=OK
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
  // v2.7.7 build fingerprint — grep this in adb logcat to verify the
  // running .so was compiled FROM this source revision (and not from
  // a stale EAS cache layer). If you don't see it, the cached build
  // is being used and the SSML auto-detect patch may not be present.
  // FORCE-FORCE marker (after first FORCE-FORCE build was still stale
  // due to uncommitted-files-on-EAS issue): if you grep this exact
  // string and see it, then the .so is the one with the SSML auto-
  // detect logic + the isNotBlank canary guard. If you don't, you
  // are running an older binary.
  LOGI("nativeInit: dataPath=%s build=v2.7.7-SSML-PARSE-MANUAL", dataPath.c_str());

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
// v2.7.7-FINAL-FORCE — PROPER per-segment SSML switch.
//
// WHY THE PREVIOUS DESIGN FAILED:
//   espeak_TextToPhonemesWithTerminator() does NOT honor the espeakSSML
//   bit in textmode. Only espeak_Synth() (the full audio path) sets
//   `option_ssml` internally — see src/libespeak-ng/speech.c lines
//   ~435 (Synthesize sets it) vs ~860 (TextToPhonemes does NOT). So
//   passing espeakCHARS_UTF8 | espeakSSML was a no-op: the SSML
//   markup got fed to the Italian translator and produced
//   "vˈɔitʃe nˈame ʊɡwˈale ˈɛn ˈiks bˈarɾa vˈɔitʃe" instead of
//   the desired "ˈɛks" for `<voice name="en">x</voice>`.
//
// WHAT WE DO INSTEAD:
//   We parse the SSML markup OURSELVES at the JNI layer. The input is
//   sliced into segments at every `<voice name="LANG">…</voice>`
//   boundary. For each segment we (a) optionally call
//   espeak_SetVoiceByName(LANG) to switch translator, (b) phonemize
//   the segment with the regular plain-text path, (c) at the end
//   restore the original voice. Three benefits over the broken flag
//   approach:
//     - works with the EXISTING espeak_TextToPhonemes API (no need to
//       expose internal `option_ssml`)
//     - the voice switch is RECORDED in the same way nativeSetVoice
//       does it, so subsequent unrelated calls continue to use the
//       intended voice
//     - cheap: at most one extra SetVoiceByName per loanword (and we
//       cache the active voice so consecutive same-language segments
//       skip the redundant call)
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

  // Fast path: no SSML markup → just phonemize as-is. This is the
  // ~99% case (toggle OFF, or src lang is `en`, or no loanword
  // matched).
  if (text.find("<voice ") == std::string::npos) {
    std::string out = phonemizePlainSegment(decodeXmlEntities(text));
    return env->NewStringUTF(out.c_str());
  }

  // SSML path. We expect the JS pre-processor to emit tags of EXACTLY
  // this shape: `<voice name="LANG">INNER</voice>`, where LANG is a
  // bare ISO code recognized by espeak (e.g. "en"). The JS layer
  // guarantees the markup is well-formed (no nesting, balanced tags,
  // no leading whitespace inside the open tag). We still defend
  // against malformed input by skipping any tag we can't parse.
  LOGI("nativePhonemize: SSML pipeline engaged, len=%zu, baseVoice=%s",
       text.size(), g_currentVoice.c_str());

  const std::string baseVoice = g_currentVoice;  // remember so we can restore
  std::string activeVoice     = baseVoice;       // mirror espeak's actual state
  std::string result;
  size_t pos = 0;

  while (pos < text.size()) {
    size_t openTag = text.find("<voice ", pos);

    // --- Outer (no-switch) segment: from pos up to openTag (or end). ---
    size_t outerEnd = (openTag == std::string::npos) ? text.size() : openTag;
    if (outerEnd > pos) {
      // Restore the base voice if we drifted away in the previous loop.
      if (activeVoice != baseVoice) {
        espeak_SetVoiceByName(baseVoice.c_str());
        activeVoice = baseVoice;
      }
      std::string outer = decodeXmlEntities(text.substr(pos, outerEnd - pos));
      result += phonemizePlainSegment(outer);
    }
    if (openTag == std::string::npos) break;

    // --- Parse the open tag: `<voice name="LANG">` ---
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
