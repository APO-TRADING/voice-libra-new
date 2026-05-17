package com.beppeaudiobooks.pipertts

/**
 * Rule-based Italian -> IPA phonemizer.
 *
 * SAFETY NET: used only when the native espeak-ng JNI bridge fails to
 * initialize (CMake build failure, NDK ABI mismatch, etc.). Italian is highly
 * phonetic so a rule-based approach gives ~95% correct pronunciation.
 *
 * The output IPA characters match those produced by espeak-ng 'it' voice so
 * they map directly to the Piper Italian phoneme_id_map.
 *
 * Algorithm:
 *   1. Lowercase + normalize whitespace.
 *   2. Scan left-to-right. At each position try (longest-first):
 *        a. Digraphs/trigraphs (gli+i, sc[ei], ch, gh, gn, qu)
 *        b. Conditional single letters (c/g before front vowels)
 *        c. Single letters (vowels, consonants 1:1)
 *   3. AFTER appending the phoneme(s) for a single source letter, if the
 *      next source char is the SAME consonant letter, append U+02D0 (length
 *      marker) and advance past it. This correctly handles "tt", "pp",
 *      "rr", "ss", "cc" (before front vowels -> tːʃ), "gg" (before front
 *      vowels -> dːʒ), etc.
 *
 * IMPORTANT: callers must check voice.espeakVoice == "it" before using this.
 * For non-Italian voices the audio will be garbled.
 */
object ItalianPhonemizer {
  // IPA characters as Kotlin constants (Kotlin requires exact \uXXXX form).
  private const val IPA_G       = "\u0261" // ɡ voiced velar plosive
  private const val IPA_NJ      = "\u0272" // ɲ palatal nasal (gn)
  private const val IPA_LJ      = "\u028E" // ʎ palatal lateral (gli)
  private const val IPA_SH      = "\u0283" // ʃ voiceless palato-alveolar (sc[ei])
  private const val IPA_ZH      = "\u0292" // ʒ voiced palato-alveolar (rare in IT)
  private const val IPA_OPEN_E  = "\u025B" // ɛ open-mid front unrounded
  private const val IPA_OPEN_O  = "\u0254" // ɔ open-mid back rounded
  private const val IPA_LENGTH  = "\u02D0" // ː length marker (geminate)

  private val FRONT_VOWELS = charArrayOf('e', 'i', '\u00E8', '\u00E9', '\u00EC', '\u00ED')

  private fun isFrontVowel(c: Char): Boolean {
    for (v in FRONT_VOWELS) if (c == v) return true
    return false
  }

  /** Convert plain Italian text to a string of IPA phonemes (no spaces between phonemes). */
  fun phonemize(input: String): String {
    if (input.isBlank()) return ""
    val text = input.lowercase().replace(Regex("\\s+"), " ").trim()
    val out = StringBuilder(text.length * 2)
    val n = text.length

    var i = 0
    while (i < n) {
      val c = text[i]
      val next = if (i + 1 < n) text[i + 1] else ' '
      val next2 = if (i + 2 < n) text[i + 2] else ' '

      // Was this source letter a single consonant that should geminate?
      // If yes, after processing we check if text[advanceTo] == c and add ː.
      var consumed = 1
      var geminableConsonant: Char? = null

      when {
        // Punctuation passes through unchanged
        c == ' ' || c == ',' || c == '.' || c == '!' || c == '?' || c == ':' || c == ';' -> {
          out.append(c)
        }
        // ---- Digraphs (consume 2 source chars) -------------------------
        c == 'c' && next == 'h' -> { out.append('k'); consumed = 2 }
        c == 'g' && next == 'h' -> { out.append(IPA_G); consumed = 2 }
        c == 'g' && next == 'n' -> { out.append(IPA_NJ); consumed = 2 }
        c == 's' && next == 'c' && (next2 == 'i' || next2 == 'e') -> { out.append(IPA_SH); consumed = 2 }
        c == 'q' && next == 'u' -> { out.append('k'); out.append('w'); consumed = 2 }
        // gli + i -> ʎi (consume "gl", let 'i' be processed as vowel next iter)
        c == 'g' && next == 'l' && next2 == 'i' -> { out.append(IPA_LJ); consumed = 2 }
        // ---- Conditional palatalization --------------------------------
        c == 'c' -> {
          if (isFrontVowel(next)) { out.append('t'); out.append(IPA_SH) } else { out.append('k') }
          geminableConsonant = c
        }
        c == 'g' -> {
          if (isFrontVowel(next)) { out.append('d'); out.append(IPA_ZH) } else { out.append(IPA_G) }
          geminableConsonant = c
        }
        c == 'z' -> { out.append('t'); out.append('s'); geminableConsonant = c }
        // ---- Vowels ----------------------------------------------------
        c == 'a' || c == '\u00E0' -> out.append('a')
        c == 'e' || c == '\u00E8' -> out.append(IPA_OPEN_E)
        c == '\u00E9' -> out.append('e')
        c == 'i' || c == '\u00EC' || c == '\u00ED' -> out.append('i')
        c == 'o' || c == '\u00F2' -> out.append(IPA_OPEN_O)
        c == '\u00F3' -> out.append('o')
        c == 'u' || c == '\u00F9' || c == '\u00FA' -> out.append('u')
        // ---- Single consonants (mostly 1:1 with IPA) -------------------
        c == 'h' -> { /* silent in Italian */ }
        c == 'y' -> { out.append('j'); geminableConsonant = c }
        c == 'x' -> { out.append('k'); out.append('s'); geminableConsonant = c }
        c == 'r' || c == 's' || c == 'b' || c == 'd' || c == 'f' ||
        c == 'j' || c == 'k' || c == 'l' || c == 'm' || c == 'n' ||
        c == 'p' || c == 't' || c == 'v' || c == 'w' -> {
          out.append(c)
          geminableConsonant = c
        }
        else -> { /* skip unknown char */ }
      }

      i += consumed

      // Geminate detection: if we just emitted a single consonant and the
      // very next source char is the same letter, emit ː and skip it.
      // (Digraphs / trigraphs return geminableConsonant = null so this
      // branch is bypassed correctly for "ch"+"i" etc.)
      if (geminableConsonant != null && i < n && text[i] == geminableConsonant) {
        out.append(IPA_LENGTH)
        i += 1
      }
    }
    return out.toString()
  }
}
