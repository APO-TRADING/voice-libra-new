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
  t = t.replace(/([.!?])([»”"]?)\s+([A-ZÀ-ÈÌÒÙ])/g, '$1$2\n\n$3');
  t = t.replace(/\.{3}([»”"]?)\s+([A-ZÀ-ÈÌÒÙ])/g, '...$1\n\n$2');
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
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?…]+(?:[.!?…]+["»”')\]]*|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out;
}

export function countWords(text: string): number {
  return (text.match(/\b\w+\b/g) || []).length;
}
