package com.beppeaudiobooks.pipertts

/**
 * Kotlin wrapper around our JNI bridge to espeak-ng.
 *
 * Loads libpiper_phonemize_jni.so (built by CMakeLists.txt) which statically
 * links espeak-ng. All methods are static and serialized via a single mutex
 * on the native side — do not call from multiple threads.
 */
object PhonemizerNative {
  private var loaded = false
  private var loadFailed = false

  /**
   * Try to load libpiper_phonemize_jni.so. If the build was made WITHOUT
   * native NDK compilation (iteration 1), the .so won't exist and we throw
   * an UnsatisfiedLinkError that the caller (PiperTtsModule) catches to
   * gracefully fall back to ItalianPhonemizer.
   */
  @Throws(UnsatisfiedLinkError::class)
  fun ensureLoaded() {
    if (loaded) return
    if (loadFailed) throw UnsatisfiedLinkError("piper_phonemize_jni previously failed to load")
    try {
      System.loadLibrary("piper_phonemize_jni")
      loaded = true
    } catch (e: UnsatisfiedLinkError) {
      loadFailed = true
      throw e
    }
  }

  @JvmStatic external fun nativeInit(dataPath: String): Int
  @JvmStatic external fun nativeSetVoice(voice: String): Int
  @JvmStatic external fun nativePhonemize(text: String): String
  @JvmStatic external fun nativeTerminate(): Int
}
