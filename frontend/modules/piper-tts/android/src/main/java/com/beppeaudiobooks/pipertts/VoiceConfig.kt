package com.beppeaudiobooks.pipertts

import org.json.JSONObject
import java.io.File

/**
 * Parsed Piper voice configuration (.onnx.json).
 *
 * Piper models ship with a JSON sidecar that defines:
 *   - audio.sample_rate          : output PCM frequency (e.g. 16000, 22050)
 *   - espeak.voice               : espeak-ng language code ("it", "en-us", ...)
 *   - phoneme_id_map             : { IPA phoneme → [int IDs] }
 *   - phoneme_type               : "espeak" or "text" (we only support espeak here)
 *   - num_symbols                : vocabulary size (sanity check)
 *   - num_speakers               : multi-speaker support (we use sid=0 for default)
 *   - inference.noise_scale      : VITS noise (default 0.667)
 *   - inference.length_scale     : speed factor (default 1.0)
 *   - inference.noise_w          : VITS noise_w (default 0.8)
 *   - language.code, language.name_english : metadata for UI
 */
data class VoiceConfig(
  val sampleRate: Int,
  val espeakVoice: String,
  val phonemeIdMap: Map<String, IntArray>,
  val numSymbols: Int,
  val numSpeakers: Int,
  val noiseScale: Float,
  val lengthScale: Float,
  val noiseW: Float,
  val languageCode: String,
  val languageName: String,
) {
  companion object {
    fun fromFile(jsonPath: String): VoiceConfig {
      val raw = File(jsonPath).readText()
      return fromJson(raw)
    }

    fun fromJson(raw: String): VoiceConfig {
      val obj = JSONObject(raw)
      val audio = obj.optJSONObject("audio") ?: JSONObject()
      val espeak = obj.optJSONObject("espeak") ?: JSONObject()
      val inference = obj.optJSONObject("inference") ?: JSONObject()
      val language = obj.optJSONObject("language") ?: JSONObject()

      val mapObj = obj.optJSONObject("phoneme_id_map")
        ?: throw IllegalArgumentException("voice .onnx.json missing phoneme_id_map")

      val ids = HashMap<String, IntArray>(mapObj.length() * 2)
      val keys = mapObj.keys()
      while (keys.hasNext()) {
        val k = keys.next()
        val arr = mapObj.optJSONArray(k) ?: continue
        val intArr = IntArray(arr.length()) { arr.getInt(it) }
        ids[k] = intArr
      }

      return VoiceConfig(
        sampleRate     = audio.optInt("sample_rate", 22050),
        espeakVoice    = espeak.optString("voice", "it"),
        phonemeIdMap   = ids,
        numSymbols     = obj.optInt("num_symbols", ids.size),
        numSpeakers    = obj.optInt("num_speakers", 1),
        noiseScale     = inference.optDouble("noise_scale", 0.667).toFloat(),
        lengthScale    = inference.optDouble("length_scale", 1.0).toFloat(),
        noiseW         = inference.optDouble("noise_w", 0.8).toFloat(),
        languageCode   = language.optString("code", ""),
        languageName   = language.optString("name_english", ""),
      )
    }
  }

  /**
   * Convert an IPA phoneme string (output of espeak_TextToPhonemes) into the
   * integer ID sequence that Piper's VITS model expects.
   *
   * Standard Piper pre-processing (from rhasspy/piper-phonemize):
   *   1. Prepend BOS = "^" (id 1 by convention)
   *   2. For each phoneme character, append PAD ("_", id 0) after the phoneme.
   *   3. Append EOS = "$" (id 2)
   *
   * We iterate codepoints to stay UTF-32 safe, and look up each one in the
   * phoneme_id_map. Some IPA codepoints are multi-byte sequences but the
   * map's keys are usually a single character each (piper-phonemize splits
   * IPA per-character before lookup, never per-phoneme).
   *
   * Defensive fallback: if the .onnx.json does NOT contain "^", "_", "$"
   * mappings (rare \u2014 every standard Piper model has them), fall back to
   * the conventional IDs (1, 0, 2) to keep the model from outputting
   * silence. This costs nothing on well-formed configs.
   */
  fun textToInputIds(ipaText: String): IntArray {
    val out = ArrayList<Int>(ipaText.length * 2 + 8)
    val bos = phonemeIdMap["^"] ?: intArrayOf(1)
    val pad = phonemeIdMap["_"] ?: intArrayOf(0)
    val eos = phonemeIdMap["$"] ?: intArrayOf(2)
    // BOS + pad — piper-phonemize emits the pad RIGHT after BOS. Missing
    // this token makes Piper's VITS model "start late", truncating the
    // first vowel and producing a robotic first word. Verified against
    // rhasspy/piper-phonemize::phonemes_to_ids().
    for (id in bos) out.add(id)
    for (id in pad) out.add(id)
    var i = 0
    while (i < ipaText.length) {
      val cp = ipaText.codePointAt(i)
      val cpStr = String(Character.toChars(cp))
      val ids = phonemeIdMap[cpStr]
      if (ids != null) {
        for (id in ids) out.add(id)
        for (id in pad) out.add(id)
      }
      i += Character.charCount(cp)
    }
    // EOS (no trailing pad — piper-phonemize doesn't emit one either).
    for (id in eos) out.add(id)
    return out.toIntArray()
  }
}
