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
import org.json.JSONObject
import java.io.File
import java.io.InputStreamReader
import java.util.concurrent.atomic.AtomicReference
import java.util.zip.GZIPInputStream

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
   * loadVoice(modelPath, configJson, espeakDataPath, options, promise)
   * Resolves with { sampleRate, lengthScale, noiseScale, noiseW, language, ... }.
   *
   * `options` is a JS object with engine knobs. Currently supported keys:
   *   useNnapi: Boolean — opt-in NNAPI execution provider (default false).
   *
   * For backwards-compat the older 4-arg form (no options) is still
   * accepted via the @ReactMethod overload below.
   */
  @ReactMethod
  fun loadVoice(modelPath: String, configJson: String, espeakDataPath: String, options: com.facebook.react.bridge.ReadableMap?, promise: Promise) {
    val useNnapi = options?.let { if (it.hasKey("useNnapi")) it.getBoolean("useNnapi") else false } ?: false
    ttsScope.launch {
      try {
        val out = doLoadVoice(modelPath, configJson, espeakDataPath, useNnapi)
        promise.resolve(out)
      } catch (e: Throwable) {
        Log.e(TAG, "loadVoice failed", e)
        promise.reject("E_LOAD", e.message ?: e.javaClass.simpleName, e)
      }
    }
  }

  private suspend fun doLoadVoice(modelPath: String, configJson: String, espeakDataPath: String, useNnapi: Boolean): com.facebook.react.bridge.WritableMap {
    Log.i(TAG, "doLoadVoice model=$modelPath espeakData=$espeakDataPath useNnapi=$useNnapi")
    if (!File(modelPath).exists()) {
      throw IllegalArgumentException("model.onnx not found at $modelPath")
    }
    val voice = withContext(Dispatchers.Default) { VoiceConfig.fromJson(configJson) }
    Log.i(TAG, "voice: sr=${voice.sampleRate} lang=${voice.languageCode} phonemes=${voice.phonemeIdMap.size} speakers=${voice.numSpeakers}")

    // Phonemizer init (best effort: NDK espeak-ng, fallback to Kotlin
    // dictionary + Italian rule-based fallback for OOV).
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
          Log.w(TAG, "espeak nativeSetVoice(${voice.espeakVoice}) -> $voiceErr; falling back to dictionary phonemizer")
        }
      } else {
        Log.w(TAG, "espeak nativeInit -> $initErr; falling back to dictionary phonemizer")
      }
    } catch (e: Throwable) {
      Log.w(TAG, "espeak-ng JNI bridge unavailable: ${e.message}; falling back to dictionary phonemizer")
    }

    // PATCH (beppe-audiobooks v11): MULTI-LANGUAGE word -> IPA dictionaries.
    // Each supported language ships a pre-computed json.gz built offline by
    // running real espeak-ng on the 50k most-frequent words for that
    // language. Coverage ~95-99% of typical audiobook text per language.
    // The remaining ~1-5% (proper nouns, neologisms, foreign words) fall
    // through to the Italian rule-based phonemizer for italian voices,
    // and to a silent pass-through for other languages.
    //
    // Supported asset files in android/src/main/assets/:
    //   it_phonemes.json.gz, en_phonemes.json.gz, es_phonemes.json.gz,
    //   fr_phonemes.json.gz, de_phonemes.json.gz
    var dictLoaded = false
    val baseLang = baseLangFromEspeak(voice.espeakVoice)
    if (!nativePhonemizerReady) {
      try {
        val dict = loadPhonemeDictionary(baseLang)
        if (dict.isNotEmpty()) {
          ItalianPhonemizer.setDictionary(dict, baseLang)
          dictLoaded = true
          Log.i(TAG, "$baseLang phonemes dictionary loaded: ${dict.size} entries")
        } else {
          Log.w(TAG, "No phoneme dictionary bundled for language '$baseLang' (espeak=${voice.espeakVoice})")
        }
      } catch (e: Throwable) {
        Log.w(TAG, "Dictionary load failed for $baseLang: ${e.message}; relying on rule-based fallback")
      }
    }

    // If neither native phonemizer nor dictionary nor Italian rule-based
    // fallback can handle this voice, abort early so the UI can show a
    // clear error rather than producing garbled speech.
    if (!nativePhonemizerReady && !dictLoaded && baseLang != "it") {
      throw RuntimeException(
        "No phonemizer available for language '$baseLang' " +
          "(espeak='${voice.espeakVoice}'). " +
          "Bundle a $baseLang dictionary or rebuild with " +
          "-PwithNativePhonemizer=true to enable native espeak-ng.")
    }

    // Build ORT session
    val previous = engineRef.getAndSet(null)
    previous?.close()
    val engine = withContext(Dispatchers.IO) { OnnxEngine(modelPath, voice, useNnapi) }
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
      putInt("phonemesDictSize", ItalianPhonemizer.dictionarySize())
      putString("phonemesDictLang", ItalianPhonemizer.dictionaryLanguage())
      putString("executionProvider", engine.executionProvider)
    }
    Log.i(TAG, "doLoadVoice OK (nativePhonemizer=$nativePhonemizerReady dictLang=${ItalianPhonemizer.dictionaryLanguage()} dictSize=${ItalianPhonemizer.dictionarySize()} EP=${engine.executionProvider})")
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
      // Legacy callers don't pass options — default to CPU EP.
      loadVoice(modelPath, raw, dataDir, null, promise)
    } catch (e: Throwable) {
      promise.reject("E_INIT", e.message ?: e.javaClass.simpleName, e)
    }
  }

  @ReactMethod
  fun deinitialize(promise: Promise) = unloadVoice(promise)

  /**
   * Synthesize the given text and write the resulting PCM as a 16-bit
   * mono WAV file in the app's cache directory. Returns the absolute path
   * so JS can hand it to expo-audio.
   *
   * This is the CORE synthesis primitive for the new architecture:
   *   text -> phonemes -> ONNX inference -> PCM -> WAV on disk -> path
   * No playback is performed here. PlayerContext.tsx feeds the WAV file
   * to expo-audio's AudioPlayer.replace(), which owns the rest of the
   * playback lifecycle (audio output + lockscreen notification + media
   * buttons via setActiveForLockScreen).
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
   * Does NOT touch playback (expo-audio is the playback owner now).
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

  /**
   * Normalize an espeak-ng voice code to its BASE language code (the
   * filename prefix of our bundled phoneme dictionaries).
   *
   * Examples:
   *   "it"      -> "it"
   *   "en-us"   -> "en"
   *   "en-gb"   -> "en"
   *   "es-419"  -> "es"
   *   "fr-fr"   -> "fr"
   *   "de"      -> "de"
   *
   * Unknown codes are returned lower-cased without the dash suffix; if no
   * matching <base>_phonemes.json.gz exists, loadPhonemeDictionary will
   * return an empty map and the caller falls back to Italian-rule-based
   * or rejects (depending on policy).
   */
  private fun baseLangFromEspeak(espeakVoice: String): String {
    val v = espeakVoice.lowercase().trim()
    if (v.isEmpty()) return "it" // safety default
    return v.substringBefore('-').substringBefore('_')
  }

  /**
   * Load a word -> IPA dictionary bundled as an Android asset
   * (gzipped JSON). Each language ships ~50k entries (~470-540KB on disk,
   * ~1.2MB uncompressed) built offline by running real espeak-ng on a
   * frequency-sorted list of the top 50k words for that language.
   *
   * Asset naming convention: <baseLang>_phonemes.json.gz
   *   it_phonemes.json.gz   (49.6k entries)
   *   en_phonemes.json.gz   (49.7k entries)
   *   es_phonemes.json.gz   (50.0k entries)
   *   fr_phonemes.json.gz   (49.9k entries)
   *   de_phonemes.json.gz   (50.0k entries)
   *
   * Returns an empty Map if the asset is not bundled (callers should
   * decide whether to error out or fall back to the rule-based engine).
   * Throws if the asset is present but malformed.
   */
  private fun loadPhonemeDictionary(baseLang: String): Map<String, String> {
    val assetName = "${baseLang}_phonemes.json.gz"
    val assets = reactContext.assets
    // Check existence without throwing — assets.open() raises IOException
    // for missing files which we want to convert to "empty map".
    val available = try {
      val all = assets.list("") ?: emptyArray()
      all.contains(assetName)
    } catch (e: Throwable) {
      false
    }
    if (!available) {
      Log.w(TAG, "Phoneme dictionary asset not bundled: $assetName")
      return emptyMap()
    }

    val raw = assets.open(assetName)
    val reader = InputStreamReader(GZIPInputStream(raw), Charsets.UTF_8)
    val json = reader.use { it.readText() }
    val obj = JSONObject(json)
    val out = HashMap<String, String>(obj.length() + 16, 0.85f)
    val keys = obj.keys()
    while (keys.hasNext()) {
      val k = keys.next()
      val v = obj.optString(k, "")
      if (v.isNotEmpty()) out[k] = v
    }
    return out
  }

  /**
   * Italian-only convenience wrapper (kept for backward compatibility with
   * code that explicitly requests Italian).
   */
  @Suppress("unused")
  private fun loadItalianDictionary(): Map<String, String> = loadPhonemeDictionary("it")

  companion object {
    private const val TAG = "PiperTtsModule"

    /** Helper if we ever need to push events back to JS — currently unused. */
    fun emit(reactContext: ReactApplicationContext, eventName: String, params: com.facebook.react.bridge.WritableMap) {
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(eventName, params)
    }
  }
}
