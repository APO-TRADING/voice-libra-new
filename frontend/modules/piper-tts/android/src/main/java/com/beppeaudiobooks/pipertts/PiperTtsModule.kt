package com.beppeaudiobooks.pipertts

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/**
 * Native module exposed to React Native as `NativeModules.TTSManager`.
 *
 * SCOPE (post react-native-track-player migration):
 *   - Engine ownership: load .onnx + .onnx.json, parse phoneme_id_map.
 *   - Synthesis: text -> phonemes -> ONNX -> Float PCM -> WAV file on disk.
 *   - NO playback. NO MediaSession. NO foreground service. All of those
 *     responsibilities now live in JS via react-native-track-player, which
 *     plays the WAV files we produce and owns the lockscreen UI.
 */
class PiperTtsModule(private val reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "TTSManager"

  // ----- Engine state -----
  private val engineRef = AtomicReference<OnnxEngine?>(null)
  private val voiceRef  = AtomicReference<VoiceConfig?>(null)
  private val ttsScope  = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var currentSynthJob: Job? = null
  /** true if libpiper_phonemize_jni.so loaded AND nativeInit succeeded. */
  private var nativePhonemizerReady = false
  /** Counter so each WAV gets a unique filename. */
  private var wavCounter = 0

  // ----- Public methods (called from JS) -----

  /**
   * loadVoice(modelPath, configJson, espeakDataPath, promise)
   * Resolves with { sampleRate, lengthScale, noiseScale, noiseW, language, ... }.
   */
  @ReactMethod
  fun loadVoice(modelPath: String, configJson: String, espeakDataPath: String, promise: Promise) {
    ttsScope.launch {
      try {
        val out = doLoadVoice(modelPath, configJson, espeakDataPath)
        promise.resolve(out)
      } catch (e: Throwable) {
        Log.e(TAG, "loadVoice failed", e)
        promise.reject("E_LOAD", e.message ?: e.javaClass.simpleName, e)
      }
    }
  }

  private suspend fun doLoadVoice(modelPath: String, configJson: String, espeakDataPath: String): com.facebook.react.bridge.WritableMap {
    Log.i(TAG, "doLoadVoice model=$modelPath espeakData=$espeakDataPath")
    if (!File(modelPath).exists()) {
      throw IllegalArgumentException("model.onnx not found at $modelPath")
    }
    val voice = withContext(Dispatchers.Default) { VoiceConfig.fromJson(configJson) }
    Log.i(TAG, "voice: sr=${voice.sampleRate} lang=${voice.languageCode} phonemes=${voice.phonemeIdMap.size} speakers=${voice.numSpeakers}")

    // Phonemizer init (best effort: NDK espeak-ng, fallback to Italian rules)
    nativePhonemizerReady = false
    try {
      PhonemizerNative.ensureLoaded()
      val initErr = PhonemizerNative.nativeInit(espeakDataPath)
      if (initErr == 0) {
        val voiceErr = PhonemizerNative.nativeSetVoice(voice.espeakVoice)
        if (voiceErr == 0) {
          nativePhonemizerReady = true
          Log.i(TAG, "espeak-ng phonemizer ready for voice=${voice.espeakVoice}")
        } else {
          Log.w(TAG, "espeak nativeSetVoice(${voice.espeakVoice}) -> $voiceErr; falling back to Italian Kotlin phonemizer")
        }
      } else {
        Log.w(TAG, "espeak nativeInit -> $initErr; falling back to Italian Kotlin phonemizer")
      }
    } catch (e: Throwable) {
      Log.w(TAG, "espeak-ng JNI bridge unavailable: ${e.message}; will use Italian fallback if voice is 'it'")
    }
    if (!nativePhonemizerReady && voice.espeakVoice != "it") {
      throw RuntimeException(
        "Native espeak-ng phonemizer unavailable AND voice language is " +
          "'${voice.espeakVoice}' (not Italian). Rebuild with -PwithNativePhonemizer=true.")
    }

    // Build ORT session
    val previous = engineRef.getAndSet(null)
    previous?.close()
    val engine = withContext(Dispatchers.IO) { OnnxEngine(modelPath, voice) }
    engineRef.set(engine)
    voiceRef.set(voice)

    val out = Arguments.createMap().apply {
      putInt("sampleRate", voice.sampleRate)
      putDouble("lengthScale", voice.lengthScale.toDouble())
      putDouble("noiseScale", voice.noiseScale.toDouble())
      putDouble("noiseW", voice.noiseW.toDouble())
      putString("languageCode", voice.languageCode)
      putString("languageName", voice.languageName)
      putInt("numSpeakers", voice.numSpeakers)
      putInt("numSymbols", voice.numSymbols)
      putString("espeakVoice", voice.espeakVoice)
      putBoolean("nativePhonemizer", nativePhonemizerReady)
    }
    Log.i(TAG, "doLoadVoice OK (nativePhonemizer=$nativePhonemizerReady)")
    return out
  }

  @ReactMethod
  fun unloadVoice(promise: Promise) {
    ttsScope.launch {
      try {
        currentSynthJob?.cancel()
        engineRef.getAndSet(null)?.close()
        voiceRef.set(null)
        // Best-effort cleanup of any leftover WAV files from previous sessions.
        runCatching { wavCacheDir().listFiles()?.forEach { it.delete() } }
        promise.resolve(null)
      } catch (e: Throwable) {
        promise.reject("E_UNLOAD", e.message ?: e.javaClass.simpleName, e)
      }
    }
  }

  /** Legacy alias kept for any consumer that still calls initializeTTS(). */
  @ReactMethod
  fun initializeTTS(sampleRate: Int, channels: Int, configJson: String, promise: Promise) {
    try {
      val obj = org.json.JSONObject(configJson)
      val modelPath = obj.getString("modelPath")
      val cfgPath   = obj.optString("configJsonPath", "").ifEmpty { obj.optString("tokensPath", "") }
      val dataDir   = obj.getString("dataDirPath")
      if (cfgPath.isEmpty()) {
        promise.reject("E_INIT", "initializeTTS needs configJsonPath in the JSON envelope")
        return
      }
      val raw = File(cfgPath).readText()
      loadVoice(modelPath, raw, dataDir, promise)
    } catch (e: Throwable) {
      promise.reject("E_INIT", e.message ?: e.javaClass.simpleName, e)
    }
  }

  @ReactMethod
  fun deinitialize(promise: Promise) = unloadVoice(promise)

  /**
   * Synthesize the given text and write the resulting PCM as a 16-bit
   * mono WAV file in the app's cache directory. Returns the absolute path
   * so JS can hand it to react-native-track-player.
   *
   * This is the CORE synthesis primitive for the new architecture:
   *   text -> phonemes -> ONNX inference -> PCM -> WAV on disk -> path
   * No playback is performed here. PlayerContext.tsx queues the WAV file
   * via TrackPlayer.add(), which owns the rest of the playback lifecycle
   * (audio output + lockscreen notification + media buttons).
   */
  @ReactMethod
  fun synthesizeToFile(text: String, sid: Int, speed: Float, promise: Promise) {
    val engine = engineRef.get()
    val voice  = voiceRef.get()
    if (engine == null || voice == null) {
      promise.reject("E_NOT_READY", "No voice loaded. Call loadVoice() first.")
      return
    }
    val job = ttsScope.launch {
      try {
        val cleanText = text.trim()
        if (cleanText.isEmpty()) {
          promise.reject("E_EMPTY", "Empty text")
          return@launch
        }
        val t0 = System.currentTimeMillis()
        // 1. Phonemize
        val ipa = withContext(Dispatchers.Default) {
          if (nativePhonemizerReady) PhonemizerNative.nativePhonemize(cleanText)
          else ItalianPhonemizer.phonemize(cleanText)
        }
        if (ipa.isEmpty()) {
          promise.reject("E_PHONEMIZE", "Phonemization produced empty output")
          return@launch
        }
        // 2. Phoneme IDs
        val ids = withContext(Dispatchers.Default) { voice.textToInputIds(ipa) }
        // 3. ONNX inference
        val pcm = withContext(Dispatchers.Default) { engine.synthesize(ids, speed, sid) }
        if (pcm.isEmpty()) {
          promise.reject("E_SYNTH_EMPTY", "ONNX returned empty PCM")
          return@launch
        }
        // 4. Write WAV
        val outPath = withContext(Dispatchers.IO) {
          wavCounter += 1
          val file = File(wavCacheDir(), "sent_${System.currentTimeMillis()}_${wavCounter}.wav")
          WavWriter.writeMono16(pcm, voice.sampleRate, file)
        }
        val dur = System.currentTimeMillis() - t0
        Log.i(TAG, "synthesizeToFile: text=${cleanText.length} chars -> ${pcm.size} samples -> $outPath in ${dur}ms")
        val out = Arguments.createMap().apply {
          putString("path", outPath)
          putInt("sampleRate", voice.sampleRate)
          putInt("numSamples", pcm.size)
          putDouble("durationMs", (pcm.size * 1000.0 / voice.sampleRate))
          putDouble("synthMs", dur.toDouble())
        }
        promise.resolve(out)
      } catch (e: Throwable) {
        Log.e(TAG, "synthesizeToFile failed", e)
        promise.reject("E_SYNTH", e.message ?: e.javaClass.simpleName, e)
      }
    }
    currentSynthJob = job
  }

  /**
   * Best-effort cancellation of any in-flight synthesis.
   * Does NOT touch playback (TrackPlayer is the playback owner now).
   */
  @ReactMethod
  fun stopPlayback(promise: Promise) {
    try {
      currentSynthJob?.cancel()
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("E_STOP", e.message ?: e.javaClass.simpleName, e)
    }
  }

  /** Clean up the WAV cache directory. Called from JS on stop/reset. */
  @ReactMethod
  fun cleanupWavCache(promise: Promise) {
    ttsScope.launch {
      try {
        val dir = wavCacheDir()
        var deleted = 0
        dir.listFiles()?.forEach { f -> if (f.delete()) deleted += 1 }
        Log.i(TAG, "cleanupWavCache: deleted $deleted files in $dir")
        promise.resolve(deleted)
      } catch (e: Throwable) {
        promise.reject("E_CLEAN", e.message ?: e.javaClass.simpleName, e)
      }
    }
  }

  /** Delete a single WAV file (used by JS after a sentence has been consumed). */
  @ReactMethod
  fun deleteWavFile(path: String, promise: Promise) {
    try {
      val file = File(path)
      val ok = if (file.exists()) file.delete() else true
      promise.resolve(ok)
    } catch (e: Throwable) {
      promise.reject("E_DEL", e.message ?: e.javaClass.simpleName, e)
    }
  }

  // ----- NativeEventEmitter no-ops (kept to silence the warning emitted by
  // any future addListener() call from JS via NativeEventEmitter). -----
  @ReactMethod fun addListener(eventName: String) { /* no-op */ }
  @ReactMethod fun removeListeners(count: Int) { /* no-op */ }

  override fun invalidate() {
    super.invalidate()
    ttsScope.cancel()
    engineRef.getAndSet(null)?.close()
  }

  private fun wavCacheDir(): File {
    val dir = File(reactContext.cacheDir, "piper-tts/wav")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  companion object {
    private const val TAG = "PiperTtsModule"

    /** Helper if we ever need to push events back to JS \u2014 currently unused. */
    fun emit(reactContext: ReactApplicationContext, eventName: String, params: com.facebook.react.bridge.WritableMap) {
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(eventName, params)
    }
  }
}
