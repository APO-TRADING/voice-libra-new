// scripts/test-stretch-cpp.cpp
//
// Standalone test harness for the v1.0.5 stretchIpaVowels() function.
// Compiles WITHOUT espeak-ng to verify the IPA-vowel duplication logic
// in isolation. Run:
//   cd /app/frontend && g++ -std=c++17 -O2 scripts/test-stretch-cpp.cpp -o /tmp/test_stretch && /tmp/test_stretch
//
// This file COPIES the helpers from phonemize_jni.cpp byte-for-byte so
// the test mirrors the production runtime exactly. Keep in sync.

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// ─── Production code copy (keep in lock-step with phonemize_jni.cpp) ───
static size_t utf8DecodeOne(const char* s, size_t maxLen, uint32_t* cp) {
  if (maxLen == 0) return 0;
  unsigned char b0 = (unsigned char)s[0];
  if ((b0 & 0x80) == 0) { *cp = b0; return 1; }
  if ((b0 & 0xE0) == 0xC0 && maxLen >= 2) {
    *cp = ((uint32_t)(b0 & 0x1F) << 6)
        |  ((uint32_t)((unsigned char)s[1] & 0x3F));
    return 2;
  }
  if ((b0 & 0xF0) == 0xE0 && maxLen >= 3) {
    *cp = ((uint32_t)(b0 & 0x0F) << 12)
        | ((uint32_t)((unsigned char)s[1] & 0x3F) << 6)
        |  ((uint32_t)((unsigned char)s[2] & 0x3F));
    return 3;
  }
  if ((b0 & 0xF8) == 0xF0 && maxLen >= 4) {
    *cp = ((uint32_t)(b0 & 0x07) << 18)
        | ((uint32_t)((unsigned char)s[1] & 0x3F) << 12)
        | ((uint32_t)((unsigned char)s[2] & 0x3F) << 6)
        |  ((uint32_t)((unsigned char)s[3] & 0x3F));
    return 4;
  }
  return 0;
}

static bool isIpaVowel(uint32_t cp) {
  switch (cp) {
    case 'a': case 'A':
    case 'e': case 'E':
    case 'i': case 'I':
    case 'o': case 'O':
    case 'u': case 'U':
    case 'y': case 'Y':
      return true;
    case 0x00E6: case 0x00C6:
    case 0x00F8: case 0x00D8:
    case 0x0153: case 0x0152:
    case 0x0250: case 0x0251: case 0x0252: case 0x0254:
    case 0x0259: case 0x025A: case 0x025B: case 0x025C:
    case 0x025D: case 0x025E:
    case 0x0264: case 0x0268: case 0x026A: case 0x026F:
    case 0x0275: case 0x0276:
      return true;
    case 0x0279:
      return false;
    case 0x0289: case 0x028A: case 0x028C: case 0x028F:
      return true;
    default:
      return false;
  }
}

static std::string stretchIpaVowels(const std::string& ipa, double factor) {
  if (factor <= 1.0 || ipa.empty()) return ipa;
  if (factor > 3.0) factor = 3.0;
  const double extraPerVowel = factor - 1.0;
  std::string out;
  out.reserve((size_t)(ipa.size() * (factor + 0.1)));
  double accumulator = 0.0;
  size_t i = 0;
  int dupCount = 0;
  while (i < ipa.size()) {
    uint32_t cp = 0;
    size_t len = utf8DecodeOne(ipa.c_str() + i, ipa.size() - i, &cp);
    if (len == 0) {
      out.push_back(ipa[i]);
      i += 1;
      continue;
    }
    out.append(ipa, i, len);
    if (isIpaVowel(cp)) {
      accumulator += extraPerVowel;
      while (accumulator >= 1.0) {
        out.append(ipa, i, len);
        accumulator -= 1.0;
        dupCount += 1;
      }
    }
    i += len;
  }
  (void)dupCount;
  return out;
}

// Helper to count IPA vowels in a string for verification.
static int countVowels(const std::string& s) {
  int n = 0;
  size_t i = 0;
  while (i < s.size()) {
    uint32_t cp = 0;
    size_t len = utf8DecodeOne(s.c_str() + i, s.size() - i, &cp);
    if (len == 0) { i++; continue; }
    if (isIpaVowel(cp)) n++;
    i += len;
  }
  return n;
}

// ─── Test cases ───
struct Case {
  const char* desc;
  const char* input;
  double factor;
  int expectedDupCount;  // number of duplicated vowels (out - in vowel count)
};

int main() {
  // IPA strings as they come from espeak-ng for English words.
  // Stress markers (ˈ U+02C8, ˌ U+02CC) and word separators (spaces) are
  // preserved unchanged.
  Case cases[] = {
    // ─── factor 1.0 — identity (no change) ───
    {"identity 1.00",                "ɡ l ˈɒ k",       1.00, 0},
    {"identity empty",               "",                1.25, 0},

    // ─── factor 1.25 (+25%) ───
    // "ə ɛ ɪ ɔ ʌ" has 5 vowels, extra=0.25, expected dup ~= 1.25 → 1
    {"1.25 five-vowel",              "ə ɛ ɪ ɔ ʌ",      1.25, 1},
    // "ɡ l ˈɒ k" = 1 vowel only → 0.25 accumulator < 1 → 0 dup
    {"1.25 one-vowel (Glock)",       "ɡ l ˈɒ k",       1.25, 0},
    // "b r ˈaʊ n" = 2 vowels → accumulator 0.5 < 1 → 0 dup
    {"1.25 two-vowel (Brown)",       "b r ˈaʊ n",      1.25, 0},
    // "k ə n ˈɛ l i" (Connelly) = 3 vowels → 0.75 < 1 → 0 dup
    {"1.25 three-vowel (Connelly)",  "k ə n ˈɛ l i",   1.25, 0},
    // "h ˈɒ l i w ˌʊ d" (Hollywood) = 3 vowels → 0.75 → 0 dup
    {"1.25 three-vowel (Hollywood)", "h ˈɒ l i w ˌʊ d",1.25, 0},
    // "m æ n h ˈæ t ə n" (Manhattan) = 3 vowels → 0.75 → 0 dup
    {"1.25 three-vowel (Manhattan)", "m æ n h ˈæ t ə n",1.25, 0},
    // 4 vowels → 1.0 dup exactly → 1 dup
    {"1.25 four-vowel",              "a e i o",         1.25, 1},
    // 8 vowels → 2.0 dup → 2 dup
    {"1.25 eight-vowel",             "a e i o u ə ɛ ɪ", 1.25, 2},

    // ─── factor 1.50 (+50%) ───
    // 5 vowels × 0.5 = 2.5 → 2 dup (accumulator 0.5 remains at end)
    {"1.50 five-vowel",              "ə ɛ ɪ ɔ ʌ",      1.50, 2},
    {"1.50 four-vowel",              "a e i o",         1.50, 2},
    {"1.50 two-vowel (Brown)",       "b r ˈaʊ n",      1.50, 1},

    // ─── factor 2.00 (+100%) ───
    // Every vowel duplicated
    {"2.00 every-vowel (Brown)",     "b r ˈaʊ n",      2.00, 2},
    {"2.00 every-vowel (Connelly)",  "k ə n ˈɛ l i",   2.00, 3},

    // ─── sanity / edge cases ───
    {"1.25 no-vowels",               "k k k k",         1.25, 0},
    {"1.25 stress-only preserved",   "ˈˌˈˌ",            1.25, 0},  // no vowels in markers
    {"factor > 3 clamped",           "ə ɛ ɪ",          5.00, 0},  // 3 vowels × 2.0 = 6 dup (clamped to 2.0)
                                                                    // Wait — clamped to 3.0, so extra=2.0
                                                                    // 3 vowels × 2.0 = 6 dup. Skip this assertion.
  };

  // For the clamp test, replace the expected count to match clamp(3.0).
  cases[sizeof(cases)/sizeof(cases[0]) - 1].expectedDupCount = 6;

  int pass = 0, fail = 0;
  for (size_t i = 0; i < sizeof(cases)/sizeof(cases[0]); i++) {
    const Case& c = cases[i];
    std::string out = stretchIpaVowels(c.input, c.factor);
    int inV = countVowels(c.input);
    int outV = countVowels(out);
    int dup = outV - inV;
    bool ok = (dup == c.expectedDupCount);
    if (ok) pass++; else fail++;
    printf("%s %-40s factor=%.2f in_vowels=%d out_vowels=%d dup=%d expected=%d  out=\"%s\"\n",
           ok ? "✅" : "❌", c.desc, c.factor, inV, outV, dup, c.expectedDupCount, out.c_str());
  }

  printf("\n%d/%lu passed, %d failed\n", pass, sizeof(cases)/sizeof(cases[0]), fail);
  return fail;
}
