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
  LOGI("nativeInit: dataPath=%s build=v2.7.7-SSML-CANARY", dataPath.c_str());

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
  LOGI("voice set to %s", voice.c_str());
  return 0;
}

// Returns the IPA-phoneme string produced by espeak for the given text.
// Sentences are separated by spaces. Stress markers (ˈ, ˌ) are preserved.
// Punctuation markers (. , ? ! : ;) are re-injected into the stream at
// clause boundaries — espeak normally STRIPS them from the phoneme
// output, but Piper VITS models are TRAINED with these tokens (they
// drive the model's prosody, intonation, and pause timing). The exact
// algorithm matches rhasspy/piper-phonemize's phonemize_eSpeak().
//
// v2.7.7: Auto-detect SSML markup. When the input text contains
// `<voice ` or `<speak` (the two SSML tags this app uses to switch
// language for foreign loanwords), we OR `espeakSSML` into the
// textmode so espeak parses the markup and switches its internal
// translator per-word — producing e.g. /ˈbɹɔːdweɪ/ for "Broadway"
// inside an Italian sentence. Plain text without markup is unaffected
// (the SSML parser is a no-op when no `<` is seen at clause boundaries),
// so this is fully backwards-compatible with the existing pipeline.
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

  // Auto-detect SSML usage: the only tags we emit from JS are
  // <voice name="en">…</voice> and (optionally) <speak>…</speak>.
  // Plain-text input never contains these substrings, so the check is
  // both cheap and unambiguous. If the user's audiobook happens to
  // contain the literal characters "<voice " (extremely unlikely in
  // narrative prose), it will be parsed as SSML — acceptable trade-off
  // since the SSML parser also handles non-markup `<` characters
  // gracefully (it skips unrecognized tags).
  const bool useSSML =
      text.find("<voice ") != std::string::npos ||
      text.find("<speak")  != std::string::npos;
  const int textmode = espeakCHARS_UTF8 | (useSSML ? espeakSSML : 0);
  if (useSSML) {
    // Diagnostic log so the user can grep adb logcat for confirmation
    // that the SSML pipeline is actually engaged (vs the Italian
    // Kotlin fallback that would read the tags aloud).
    LOGI("nativePhonemize: SSML markup detected, espeakSSML flag ON (textmode=0x%x, len=%zu)",
         textmode, text.size());
  }

  // Internal espeak-ng clause-type constants (from src/libespeak-ng/translate.h
  // at the pinned commit). Lower 20 bits encode the punctuation kind.
  // The CLAUSE_TYPE_SENTENCE bit (in upper bits) signals end-of-sentence.
  static constexpr int CLAUSE_TYPE_MASK    = 0x000FFFFF;
  static constexpr int CLAUSE_PERIOD       = 40 | 0x00000000 | 0x00080000;
  static constexpr int CLAUSE_COMMA        = 20 | 0x00001000 | 0x00040000;
  static constexpr int CLAUSE_QUESTION     = 40 | 0x00002000 | 0x00080000;
  static constexpr int CLAUSE_EXCLAMATION  = 45 | 0x00003000 | 0x00080000;
  static constexpr int CLAUSE_COLON        = 30 | 0x00000000 | 0x00040000;
  static constexpr int CLAUSE_SEMICOLON    = 30 | 0x00001000 | 0x00040000;

  // espeak_TextToPhonemesWithTerminator() reads from a const void**
  // pointer (a moving cursor into the text), returns a const char* into
  // an INTERNAL buffer that's reused on each call, AND writes the clause
  // terminator code into the int* — letting us know if THIS clause ended
  // with `.`, `,`, `?`, `!`, `:`, or `;` so we can re-inject the proper
  // punctuation marker into the phoneme stream.
  //
  // phonememode = 0x02 → IPA UTF-8 output (bit 1 = use IPA).
  // Stress markers (ˈ ˌ) and length (ː) are embedded inline by default.
  const void* textPtr = text.c_str();
  std::string result;
  while (textPtr != nullptr) {
    int terminator = 0;
    const char* chunk = espeak_TextToPhonemesWithTerminator(
        &textPtr,
        textmode,
        /*phonememode=*/0x02,
        &terminator);
    if (chunk && *chunk) {
      result.append(chunk);
    }
    // Re-inject the punctuation marker EXACTLY as piper-phonemize does
    // it for Piper VITS models. See rhasspy/piper-phonemize src/phonemize.cpp.
    int punct = terminator & CLAUSE_TYPE_MASK;
    if (punct == CLAUSE_PERIOD) {
      result.push_back('.');
    } else if (punct == CLAUSE_QUESTION) {
      result.push_back('?');
    } else if (punct == CLAUSE_EXCLAMATION) {
      result.push_back('!');
    } else if (punct == CLAUSE_COMMA) {
      result.push_back(',');
      result.push_back(' ');
    } else if (punct == CLAUSE_COLON) {
      result.push_back(':');
      result.push_back(' ');
    } else if (punct == CLAUSE_SEMICOLON) {
      result.push_back(';');
      result.push_back(' ');
    }
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
