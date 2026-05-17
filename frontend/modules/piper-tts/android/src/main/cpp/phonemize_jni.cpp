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
  LOGI("nativeInit: dataPath=%s", dataPath.c_str());

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

  // espeak_TextToPhonemes() reads from a const void** pointer (a moving
  // cursor into the text) and returns a const char* into an INTERNAL
  // buffer that's reused on each call — so we copy out immediately.
  // textmode = espeakCHARS_UTF8; phonememode = bits set:
  //   bit 0: 0 = use IPA; 1 = use espeak ASCII
  //   bit 1: 1 = include stress markers
  //   bit 4-7: 0 = no separator; 1-4 = various separators; we want 2 (use Unicode IPA chars).
  // We want IPA with stress markers, no extra separator between phonemes.
  // phonememode = 0x02 (bit0=0 IPA, bit1=1 stress).
  const void* textPtr = text.c_str();
  std::string result;
  while (textPtr != nullptr) {
    const char* chunk = espeak_TextToPhonemes(
        &textPtr,
        /*textmode=*/espeakCHARS_UTF8,
        /*phonememode=*/0x02);
    if (!chunk) break;
    result.append(chunk);
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
