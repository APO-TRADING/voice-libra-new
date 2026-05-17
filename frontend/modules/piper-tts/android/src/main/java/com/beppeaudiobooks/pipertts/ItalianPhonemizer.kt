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
 * IMPORTANT: callers must check voice.espeakVoice == "it" before using this.
 * For non-Italian voices the audio will be garbled.
 */
object ItalianPhonemizer {
  // IPA characters as Kotlin constants (Kotlin requires exact \uXXXX form).
  private const val IPA_G       = "\u0261" // \u0261 voiced velar plosive
  private const val IPA_NJ      = "\u0272" // \u0272 palatal nasal (gn)
  private const val IPA_LJ      = "\u028E" // \u028E palatal lateral (gli)
  private const val IPA_SH      = "\u0283" // \u0283 voiceless palato-alveolar fricative (sc[ei])
  private const val IPA_ZH      = "\u0292" // \u0292 voiced palato-alveolar fricative
  private const val IPA_OPEN_E  = "\u025B" // \u025B open-mid front unrounded
  private const val IPA_OPEN_O  = "\u0254" // \u0254 open-mid back rounded
  private const val IPA_LENGTH  = "\u02D0" // \u02D0 length marker (geminate)

  /** Convert plain Italian text to a string of IPA phonemes (no spaces between phonemes). */
  fun phonemize(input: String): String {
    if (input.isBlank()) return ""
    val text = input.lowercase().replace(Regex("\\s+"), " ").trim()
    val out = StringBuilder(text.length * 2)

    var i = 0
    val n = text.length
    while (i < n) {
      val c = text[i]
      val next = if (i + 1 < n) text[i + 1] else ' '
      val next2 = if (i + 2 < n) text[i + 2] else ' '

      when {
        // Punctuation passes through unchanged
        c == ' ' || c == ',' || c == '.' || c == '!' || c == '?' || c == ':' || c == ';' -> {
          out.append(c); i += 1
        }
        // Digraphs (longest match first)
        c == 'c' && next == 'h' -> { out.append('k'); i += 2 }
        c == 'g' && next == 'h' -> { out.append(IPA_G); i += 2 }
        c == 'g' && next == 'n' -> { out.append(IPA_NJ); i += 2 }
        c == 'g' && next == 'l' && next2 == 'i' -> { out.append(IPA_LJ); i += 2 }
        c == 's' && next == 'c' && (next2 == 'i' || next2 == 'e') -> { out.append(IPA_SH); i += 2 }
        c == 'q' && next == 'u' -> { out.append('k'); out.append('w'); i += 2 }
        // Conditional consonants (palatalize before front vowels)
        c == 'c' -> when (next) {
          'e', 'i', '\u00E8', '\u00E9', '\u00EC', '\u00ED' -> { out.append('t'); out.append(IPA_SH); i += 1 }
          else -> { out.append('k'); i += 1 }
        }
        c == 'g' -> when (next) {
          'e', 'i', '\u00E8', '\u00E9', '\u00EC', '\u00ED' -> { out.append('d'); out.append(IPA_ZH); i += 1 }
          else -> { out.append(IPA_G); i += 1 }
        }
        c == 'z' -> { out.append('t'); out.append('s'); i += 1 }
        // Doubled consonants -> length marker
        c.isLetter() && c == next && c != 'a' && c != 'e' && c != 'i' && c != 'o' && c != 'u' -> {
          out.append(c); out.append(IPA_LENGTH); i += 2
        }
        // Vowels
        c == 'a' || c == '\u00E0' -> { out.append('a'); i += 1 }
        c == 'e' || c == '\u00E8' -> { out.append(IPA_OPEN_E); i += 1 }
        c == '\u00E9' -> { out.append('e'); i += 1 }
        c == 'i' || c == '\u00EC' || c == '\u00ED' -> { out.append('i'); i += 1 }
        c == 'o' || c == '\u00F2' -> { out.append(IPA_OPEN_O); i += 1 }
        c == '\u00F3' -> { out.append('o'); i += 1 }
        c == 'u' || c == '\u00F9' || c == '\u00FA' -> { out.append('u'); i += 1 }
        // Single consonants (most 1:1 to IPA for Italian)
        c == 'h' -> { i += 1 } // silent in italian
        c == 'y' -> { out.append('j'); i += 1 }
        c == 'x' -> { out.append('k'); out.append('s'); i += 1 }
        c == 'r' || c == 's' || c == 'b' || c == 'd' || c == 'f' ||
        c == 'j' || c == 'k' || c == 'l' || c == 'm' || c == 'n' ||
        c == 'p' || c == 't' || c == 'v' || c == 'w' -> { out.append(c); i += 1 }
        else -> { i += 1 } // skip unknown
      }
    }
    return out.toString()
  }
}
