package com.beppeaudiobooks.pipertts

import android.content.Intent
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
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
 * Keeps the same method names as the legacy `TTSManager` (from
 * react-native-sherpa-onnx-offline-tts) so the JS layer can swap from one
 * to the other transparently — just the underlying engine has changed:
 *
 *   sherpa-onnx 1.13.2  →  Microsoft onnxruntime-android + espeak-ng (NDK).
 */
class PiperTtsModule(private val reactContext: ReactApplicationContext)
  : ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "TTSManager"

  // ----- Engine state -----
  private val engineRef = AtomicReference<OnnxEngine?>(null)
  private val voiceRef  = AtomicReference<VoiceConfig?>(null)
  private val player    = PiperAudioPlayer()
  private val ttsScope  = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private var currentSynthJob: Job? = null
  // ----- Phonemizer state -----
  /** true if libpiper_phonemize_jni.so loaded AND nativeInit succeeded. */
  private var nativePhonemizerReady = false

  // ----- Public methods (called from JS) -----

  /**
   * loadVoice(modelPath, configJson, espeakDataPath, promise)
   *   - modelPath:      absolute path to model.onnx in app's files dir
   *   - configJson:     raw JSON string of the .onnx.json sidecar
   *   - espeakDataPath: absolute path to the espeak-ng-data dir (extracted)
   *
   * Resolves with { sampleRate, lengthScale, noiseScale, noiseW, language }.
   */
  @ReactMethod
  fun loadVoice(modelPath: String, configJson: String, espeakDataPath: String, promise: Promise) {
    ttsScope.launch {
      try {
        Log.i(TAG, "loadVoice start model=$modelPath espeakData=$espeakDataPath")
        if (!File(modelPath).exists()) {
          throw IllegalArgumentException("model.onnx not found at $modelPath")
        }
        // 1. Parse the JSON sidecar (no extraction, no metadata injection).
        val voice = withContext(Dispatchers.Default) { VoiceConfig.fromJson(configJson) }
        Log.i(TAG, "voice config: sr=${voice.sampleRate} lang=${voice.languageCode} " +
            "phonemes=${voice.phonemeIdMap.size} speakers=${voice.numSpeakers}")

        // 2. Initialize espeak-ng native phonemizer (idempotent). Failure here
        //    is NOT fatal: we fall back to a pure-Kotlin Italian phonemizer for
        //    voices whose espeak code is "it". For other languages we'll throw.
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
              Log.w(TAG, "espeak nativeSetVoice(${voice.espeakVoice}) -> $voiceErr; falling back")
            }
          } else {
            Log.w(TAG, "espeak nativeInit -> $initErr; falling back")
          }
        } catch (e: Throwable) {
          // .so failed to load, or any other native crash \u2014 just degrade.
          Log.w(TAG, "espeak-ng JNI bridge unavailable: ${e.message}; will use Italian fallback if voice is 'it'")
        }
        if (!nativePhonemizerReady && voice.espeakVoice != "it") {
          throw RuntimeException(
            "Native espeak-ng phonemizer unavailable AND requested voice " +
              "language is '${voice.espeakVoice}' (not Italian). The built-in " +
              "Italian fallback phonemizer cannot handle this language. " +
              "Rebuild the APK after fixing the espeak-ng CMake compile.")
        }

        // 3. Build ORT session (this is the slow step — may take 5-30s for
        //    large models like piper medium ~64MB).
        val previous = engineRef.getAndSet(null)
        previous?.close()
        val engine = withContext(Dispatchers.IO) { OnnxEngine(modelPath, voice) }
        engineRef.set(engine)
        voiceRef.set(voice)
        player.ensureTrack(voice.sampleRate)

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
        }
        Log.i(TAG, "loadVoice OK")
        promise.resolve(out)
      } catch (e: Throwable) {
        Log.e(TAG, "loadVoice failed", e)
        promise.reject("E_LOAD", e.message ?: e.javaClass.simpleName, e)
      }
    }
  }

  @ReactMethod
  fun unloadVoice(promise: Promise) {
    ttsScope.launch {
      try {
        currentSynthJob?.cancel()
        player.stop()
        engineRef.getAndSet(null)?.close()
        voiceRef.set(null)
        promise.resolve(null)
      } catch (e: Throwable) {
        promise.reject("E_UNLOAD", e.message ?: e.javaClass.simpleName, e)
      }
    }
  }

  /**
   * Backwards-compatible alias used by the legacy piperEngine.ts code path.
   * Accepts a JSON config string with { modelPath, configJsonPath, dataDirPath }.
   * Simply parses the JSON envelope then forwards to loadVoice() so the
   * promise behaviour and return value are identical.
   */
  @ReactMethod
  fun initializeTTS(sampleRate: Int, channels: Int, configJson: String, promise: Promise) {
    try {
      val obj = org.json.JSONObject(configJson)
      val modelPath = obj.getString("modelPath")
      val cfgPath   = obj.optString("configJsonPath", "")
        .ifEmpty { obj.optString("tokensPath", "") }
      val dataDir   = obj.getString("dataDirPath")
      if (cfgPath.isEmpty()) {
        promise.reject("E_INIT",
          "initializeTTS needs configJsonPath (or legacy tokensPath) in the config JSON")
        return
      }
      val raw = File(cfgPath).readText()
      // Forward to loadVoice() directly using the same Promise.
      loadVoice(modelPath, raw, dataDir, promise)
    } catch (e: Throwable) {
      promise.reject("E_INIT", e.message ?: e.javaClass.simpleName, e)
    }
  }

  @ReactMethod
  fun deinitialize(promise: Promise) {
    unloadVoice(promise)
  }

  /**
   * Synthesize the given text and play it through AudioTrack.
   * Resolves when playback completes (or is interrupted).
   */
  @ReactMethod
  fun generateAndPlay(text: String, sid: Int, speed: Float, promise: Promise) {
    val engine = engineRef.get()
    val voice  = voiceRef.get()
    if (engine == null || voice == null) {
      promise.reject("E_NOT_READY", "No voice loaded. Call loadVoice() first.")
      return
    }
    currentSynthJob?.cancel()
    currentSynthJob = ttsScope.launch {
      try {
        // 1. Phonemize the text. Prefer espeak-ng for full language support;
        //    fall back to the Italian rule-based phonemizer if the native
        //    bridge failed to initialize.
        val ipa = withContext(Dispatchers.Default) {
          if (nativePhonemizerReady) PhonemizerNative.nativePhonemize(text)
          else ItalianPhonemizer.phonemize(text)
        }
        if (ipa.isEmpty()) {
          promise.resolve(null)
          return@launch
        }
        // 2. Convert IPA chars to phoneme IDs via the voice's map.
        val ids = withContext(Dispatchers.Default) { voice.textToInputIds(ipa) }

        // 3. Run ONNX inference.
        val pcm = withContext(Dispatchers.Default) { engine.synthesize(ids, speed, sid) }

        // 4. Play.
        withContext(Dispatchers.IO) {
          player.ensureTrack(voice.sampleRate)
          player.playPcmBlocking(pcm)
        }
        promise.resolve(null)
      } catch (e: Throwable) {
        Log.e(TAG, "generateAndPlay failed", e)
        promise.reject("E_SYNTH", e.message ?: e.javaClass.simpleName, e)
      }
    }
  }

  /**
   * Generic version with default sid and speed for convenience from JS.
   */
  @ReactMethod
  fun stopPlayback(promise: Promise) {
    try {
      currentSynthJob?.cancel()
      player.stop()
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("E_STOP", e.message ?: e.javaClass.simpleName, e)
    }
  }

  // ----- MediaSession / foreground service -----

  @ReactMethod
  fun startPlaybackSession(info: ReadableMap, promise: Promise) {
    try {
      val intent = Intent(reactContext, PiperPlaybackService::class.java).apply {
        action = PiperPlaybackService.ACTION_START
        putExtra(PiperPlaybackService.EXTRA_TITLE,  info.getString("title") ?: "Audiobook")
        putExtra(PiperPlaybackService.EXTRA_AUTHOR, info.getString("author") ?: "")
        putExtra(PiperPlaybackService.EXTRA_COVER,  info.getString("coverBase64") ?: "")
        putExtra(PiperPlaybackService.EXTRA_PLAYING, info.takeIfHas("isPlaying")?.let { info.getBoolean("isPlaying") } ?: true)
      }
      reactContext.startForegroundService(intent)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("E_FG", e.message ?: e.javaClass.simpleName, e)
    }
  }

  @ReactMethod
  fun updatePlaybackSession(info: ReadableMap, promise: Promise) {
    try {
      val intent = Intent(reactContext, PiperPlaybackService::class.java).apply {
        action = PiperPlaybackService.ACTION_UPDATE
        putExtra(PiperPlaybackService.EXTRA_TITLE,  info.takeIfHas("title")?.let { info.getString("title") })
        putExtra(PiperPlaybackService.EXTRA_AUTHOR, info.takeIfHas("author")?.let { info.getString("author") })
        putExtra(PiperPlaybackService.EXTRA_COVER,  info.takeIfHas("coverBase64")?.let { info.getString("coverBase64") })
        putExtra(PiperPlaybackService.EXTRA_PLAYING, info.takeIfHas("isPlaying")?.let { info.getBoolean("isPlaying") } ?: true)
      }
      reactContext.startService(intent)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("E_FG_UPD", e.message ?: e.javaClass.simpleName, e)
    }
  }

  @ReactMethod
  fun stopPlaybackSession(promise: Promise) {
    try {
      val intent = Intent(reactContext, PiperPlaybackService::class.java).apply {
        action = PiperPlaybackService.ACTION_STOP
      }
      reactContext.startService(intent)
      promise.resolve(null)
    } catch (e: Throwable) {
      promise.reject("E_FG_STOP", e.message ?: e.javaClass.simpleName, e)
    }
  }

  // Methods required by NativeEventEmitter so JS doesn't crash registering
  // listeners (we emit `piperMediaAction` and `piperAudioFocus` from
  // PiperPlaybackService via DeviceEventManagerModule.RCTDeviceEventEmitter).
  @ReactMethod fun addListener(eventName: String) { /* no-op */ }
  @ReactMethod fun removeListeners(count: Int) { /* no-op */ }

  override fun invalidate() {
    super.invalidate()
    ttsScope.cancel()
    player.release()
    engineRef.getAndSet(null)?.close()
  }

  companion object {
    private const val TAG = "PiperTtsModule"

    /** Helper used from PiperPlaybackService to dispatch media-button events back to JS. */
    fun emit(reactContext: ReactApplicationContext, eventName: String, params: com.facebook.react.bridge.WritableMap) {
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(eventName, params)
    }
  }
}

private fun ReadableMap.takeIfHas(key: String): ReadableMap? =
  if (this.hasKey(key) && !this.isNull(key)) this else null
