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

      // PATCH (v2.1): normalize the espeak voice so that variants like
      // "it_IT", "it-IT", "IT", "ITA", "italian" all map to a valid
      // espeak code. The Piper json often has only `language.code` and
      // no explicit `espeak.voice` (especially for community-trained
      // custom models). We honour the explicit `espeak.voice` field
      // FIRST, falling back to `language.code` / `language.family`.
      val rawEspeakVoice = espeak.optString("voice", "")
      val rawLangCode = language.optString("code", "")
      val rawLangFamily = language.optString("family", "")
      val rawLangRegion = language.optString("region", "")
      val rawLangName = language.optString("name_english", "")
      val finalEspeakVoice = normalizeEspeakVoice(
        explicit = rawEspeakVoice,
        langCode = rawLangCode,
        langFamily = rawLangFamily,
        langRegion = rawLangRegion,
        langName = rawLangName,
      )

      return VoiceConfig(
        sampleRate     = audio.optInt("sample_rate", 22050),
        espeakVoice    = finalEspeakVoice,
        phonemeIdMap   = ids,
        numSymbols     = obj.optInt("num_symbols", ids.size),
        numSpeakers    = obj.optInt("num_speakers", 1),
        noiseScale     = inference.optDouble("noise_scale", 0.667).toFloat(),
        lengthScale    = inference.optDouble("length_scale", 1.0).toFloat(),
        noiseW         = inference.optDouble("noise_w", 0.8).toFloat(),
        languageCode   = rawLangCode,
        languageName   = rawLangName,
      )
    }

    /**
     * Resolve any free-form language hint to a valid espeak-ng voice code.
     *
     * Examples (all map to the same canonical code):
     *   "it"          → "it"
     *   "it-IT"       → "it"
     *   "it_IT"       → "it"
     *   "IT"          → "it"
     *   "italian"     → "it"
     *   "en"          → "en-us"  (espeak default fallback)
     *   "en-US"       → "en-us"
     *   "en-GB"       → "en-gb"
     *   "en_GB"       → "en-gb"
     *   "es"          → "es"
     *   "es-ES"       → "es"
     *   "es-419"      → "es-419"
     *   "es-MX"       → "es-419"
     *   "fr"          → "fr-fr"
     *   "fr-CA"       → "fr-fr" (espeak ships fr-fr / fr-ch only)
     *   "de" / "de-DE"→ "de"
     *   "pt-BR"       → "pt-br"
     *   "pt"          → "pt"
     *
     * The first non-empty argument wins. If everything is empty we default
     * to "it" (the app's primary language).
     */
    @JvmStatic
    fun normalizeEspeakVoice(
      explicit: String,
      langCode: String,
      langFamily: String,
      langRegion: String,
      langName: String,
    ): String {
      val candidates = listOf(explicit, langCode, langFamily, langName).map { it.trim().lowercase() }
      val region = langRegion.trim().lowercase()
      for (c in candidates) {
        if (c.isEmpty()) continue
        val matched = mapToEspeak(c, region)
        if (matched != null) return matched
      }
      // Last-ditch: try matching language family alone.
      val fam = langFamily.trim().lowercase()
      if (fam.isNotEmpty()) {
        val matched = mapToEspeak(fam, region)
        if (matched != null) return matched
      }
      return "it"
    }

    private fun mapToEspeak(raw: String, region: String): String? {
      // Strip any modifiers: "it-IT", "it_IT", "italian (Italy)"
      val cleaned = raw
        .replace('_', '-')
        .substringBefore(' ')
        .substringBefore('(')
        .trim()
      if (cleaned.isEmpty()) return null
      val parts = cleaned.split('-')
      val base = parts[0]
      val regionPart = (parts.getOrNull(1) ?: region).lowercase()
      // Full friendly names → ISO codes.
      val byName = mapOf(
        "italian" to "it",
        "italiano" to "it",
        "english" to "en-us",
        "spanish" to "es",
        "español" to "es",
        "espanol" to "es",
        "french" to "fr-fr",
        "français" to "fr-fr",
        "francais" to "fr-fr",
        "german" to "de",
        "deutsch" to "de",
        "portuguese" to "pt",
        "português" to "pt",
        "portugues" to "pt",
        "russian" to "ru",
        "dutch" to "nl",
        "polish" to "pl",
        "catalan" to "ca",
        "romanian" to "ro",
        "greek" to "el",
        "turkish" to "tr",
        "ukrainian" to "uk",
        "arabic" to "ar",
        "hindi" to "hi",
        "chinese" to "cmn",
        "japanese" to "ja",
        "korean" to "ko",
      )
      byName[cleaned]?.let { return it }
      // Note: we deliberately don't return on a base-only match (e.g.
      // "english") because the region-aware switch below handles the
      // refinement (en-us vs en-gb, es vs es-419, fr-fr vs fr-ch).
      // Region-aware refinements: only apply for languages with multiple
      // espeak variants. For everything else (it, de, pl, …) the base code
      // is what espeak ships.
      return when (base) {
        "it", "ita" -> "it"
        "en", "eng" -> when (regionPart) {
          "us", "usa", "419" -> "en-us"
          "gb", "uk" -> "en-gb"
          "ca" -> "en-us" // ships closest
          "au", "aus" -> "en-gb-x-rp"
          "ie", "irl" -> "en-gb"
          "in", "ind" -> "en-us"
          else -> "en-us" // safe default
        }
        "es", "spa" -> when (regionPart) {
          "mx", "ar", "co", "cl", "pe", "uy", "ve", "419", "us" -> "es-419"
          else -> "es"
        }
        "fr", "fra", "fre" -> when (regionPart) {
          "ch" -> "fr-ch"
          else -> "fr-fr"
        }
        "de", "deu", "ger" -> "de"
        "pt", "por" -> when (regionPart) {
          "br", "brasil", "brazil" -> "pt-br"
          else -> "pt"
        }
        "ru", "rus" -> "ru"
        "nl", "nld", "dut" -> "nl"
        "pl", "pol" -> "pl"
        "ca", "cat" -> "ca"
        "ro", "rum", "ron" -> "ro"
        "el", "gre", "ell" -> "el"
        "tr", "tur" -> "tr"
        "uk", "ukr" -> "uk"
        "ar", "ara" -> "ar"
        "hi", "hin" -> "hi"
        "zh", "chi", "cmn", "yue" -> if (base == "yue" || regionPart == "hk") "yue" else "cmn"
        "ja", "jpn" -> "ja"
        "ko", "kor" -> "ko"
        else -> {
          // Unknown — return the base as-is if it's a 2/3-letter code.
          if (base.matches(Regex("^[a-z]{2,3}$"))) base else null
        }
      }
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
