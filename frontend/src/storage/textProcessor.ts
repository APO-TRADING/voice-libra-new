// Pure-TS text cleaner + sentence splitter, ported from
// scripts/text-converter-cleaner-v5.py. Italian-aware.
// Used after raw text extraction from a TXT (or future formats) before storing.

function joinBroken(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      out.push('');
      continue;
    }
    if (i === lines.length - 1 || /[.!?:"»]$/.test(line)) {
      out.push(line);
    } else {
      const next = (lines[i + 1] || '').trim();
      if (next && (next[0] === next[0].toLowerCase() || ',:;)]}'.includes(next[0]))) {
        out.push(`${line} ${next}`);
        i += 1;
      } else {
        out.push(line);
      }
    }
  }
  return out.join('\n');
}

function fixPunctuation(t: string): string {
  t = t.replace(/\.([»”"])/g, '$1.');
  // Add space after punctuation if missing (but not before quotes/digits)
  t = t.replace(/([.!?:;,])([^\s»""])(?!\d)/g, '$1 $2');
  // Remove space before punctuation
  t = t.replace(/(\s)([.!?:;,])/g, '$2');
  // Remove space after opening quotes
  t = t.replace(/([«""])\s+/g, '$1');
  // Remove space before closing quotes
  t = t.replace(/\s+([»""])/g, '$1');
  // Normalise ellipsis
  t = t.replace(/\.\s*\.\s*\./g, '...');
  return t;
}

function specials(t: string): string {
  t = t.replace(/[—–]/g, '-');
  t = t.replace(/^[\s•\-*]+/gm, '');
  t = t.replace(/-{2,}/g, '-');
  return t;
}

function addParagraphBreaks(t: string): string {
  t = t.replace(/\n{3,}/g, '\n\n');
  // v2.6 (per user spec): break paragraphs ONLY on `.`, `!`, `?`.
  // `…` (U+2026) and any other punctuation are NOT sentence boundaries.
  t = t.replace(/([.!?])([»”"]?)\s+([A-ZÀ-ÈÌÒÙ])/g, '$1$2\n\n$3');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t;
}

function joinShortParagraphs(t: string, minLen = 40): string {
  const paragraphs = t.split('\n\n');
  const out: string[] = [];
  let i = 0;
  while (i < paragraphs.length) {
    const cur = paragraphs[i].trim();
    if (!cur) {
      i += 1;
      continue;
    }
    if (cur.length < minLen && i < paragraphs.length - 1) {
      const isHeading = cur.endsWith(':') || cur === cur.toUpperCase();
      if (!isHeading) {
        const nxt = paragraphs[i + 1].trim();
        if (nxt) {
          out.push(`${cur} ${nxt}`);
          i += 2;
          continue;
        }
      }
    }
    out.push(cur);
    i += 1;
  }
  return out.join('\n\n');
}

function removePageNumbers(t: string): string {
  t = t.replace(/^\s*\d+\s*$/gm, '');
  t = t.replace(/^\s*Page \d+ of \d+\s*$/gm, '');
  t = t.replace(/^\s*\d+\s*\|\s*Page\s*$/gm, '');
  return t.replace(/\n{3,}/g, '\n\n');
}

export function cleanText(input: string): string {
  let t = input;
  t = t.replace(/-\s*\n/g, '');
  t = t.replace(/[\u00A0\t]+/g, ' ');
  t = t.replace(/\n{2,}/g, '\n\n');
  t = joinBroken(t);
  t = fixPunctuation(t);
  t = specials(t);
  t = t.replace(/ +/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = addParagraphBreaks(t);
  t = joinShortParagraphs(t);
  t = removePageNumbers(t);
  return t.trim();
}

// Italian-aware sentence splitter.
//
// v2.6 (per user spec): splits ONLY at strong terminators `.`, `!`, `?`.
// Never at `…` (U+2026), `;`, `:`, or commas — keeping these mid-clause
// preserves natural prosody and avoids the "robotic chopping" effect
// the user reported. Italian abbreviations and inline numerics with a
// `.` are still protected so we don't split on them.
//
// Algorithm:
//   1. Replace '.' with a non-breaking placeholder inside protected patterns:
//      - Italian abbreviations: Sig., Sig.ra, Dott., Dr., Prof., pag., ecc.,
//        n., art., es., cap., sec., min., kg., m., cm., Mr., Mrs., St., vol.
//      - Numeric decimals/thousand-separators: 3.14, 1.000, 10.500.000
//      - Single-letter initials: F. Smith, A. Manzoni
//      - URLs and email addresses: www.example.com, a@b.com
//   2. Run the strong-terminator splitter over the masked text.
//   3. Trim each chunk and unmask placeholders so the output looks original.
//
// Edge case: if a sentence ends with one of these patterns (e.g. "...ecc.")
// the trailing '.' stays masked, joining it with the next sentence. This
// is the lesser evil compared to truncating in the middle of a noun phrase.
const DOT_PLACEHOLDER = '\u0001';

const IT_ABBREVIATIONS: RegExp[] = [
  // Title abbreviations followed by capitalised name: "Sig. Mario"
  /\b(Sig|Sig\.ra|Sigg|Dott|Dr|Dssa|Prof|Profssa|Avv|Ing|Arch|On|Ven|Mons|Rev|S|SS)\./g,
  // Common short abbreviations followed by a word: "ecc.", "pag. 12"
  /\b(ecc|pag|n|art|es|cap|vol|sec|min|kg|cm|mm|km|hr|h|ml|cl|c|tel|fax|via|p|pp)\./gi,
  // English honorifics that often appear in translated text
  /\b(Mr|Mrs|Ms|St|Jr|Sr)\./g,
];

// Single uppercase letter + period + space + Word -> initial.
const INITIAL_PATTERN = /\b([A-ZÀ-Ý])\.\s+([A-ZÀ-Ý])/g;

// Decimal / thousand-separator numbers: 1.234, 1.000.000, 3.14.
const NUMERIC_PATTERN = /(\d)\.(\d)/g;

// URL / email dots.
const URL_PATTERN = /([a-zA-Z0-9])\.([a-zA-Z][a-zA-Z0-9])/g;

function maskProtected(text: string): string {
  let t = text;
  for (const re of IT_ABBREVIATIONS) {
    t = t.replace(re, (m) => m.slice(0, -1) + DOT_PLACEHOLDER);
  }
  // Initials need a different replacement (keep the trailing space + capital).
  t = t.replace(INITIAL_PATTERN, (_m, a, b) => `${a}${DOT_PLACEHOLDER} ${b}`);
  t = t.replace(NUMERIC_PATTERN, (_m, a, b) => `${a}${DOT_PLACEHOLDER}${b}`);
  t = t.replace(URL_PATTERN, (_m, a, b) => `${a}${DOT_PLACEHOLDER}${b}`);
  return t;
}

function unmask(text: string): string {
  return text.replace(new RegExp(DOT_PLACEHOLDER, 'g'), '.');
}

export function splitSentences(text: string): string[] {
  const masked = maskProtected(text);
  const out: string[] = [];
  // v2.6 (per user spec): split ONLY on `.`, `!`, `?` — never on `…`,
  // `;`, `:`, or any other punctuation. Closing quotes/brackets stay
  // glued to the terminator so quoted speech keeps its punctuation.
  const re = /[^.!?]+(?:[.!?]+["»”')\]]*|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const s = unmask(m[0]).trim();
    if (s) out.push(s);
  }
  return out;
}

export function countWords(text: string): number {
  return (text.match(/\b\w+\b/g) || []).length;
}
