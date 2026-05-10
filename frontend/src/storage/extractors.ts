// Offline ebook text extractors: PDF, EPUB, DOCX, TXT.
// All pure JavaScript — no native modules, no server.
import * as FileSystem from 'expo-file-system/legacy';
import { unzipSync } from 'fflate';

// ─────────── helpers ───────────
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&laquo;/g, '«')
    .replace(/&raquo;/g, '»')
    .replace(/&ldquo;/g, '"')
    .replace(/&rdquo;/g, '"')
    .replace(/&lsquo;/g, '\u2018')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&hellip;/g, '...')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtmlTags(html: string): string {
  // Drop <script> / <style> blocks entirely
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // Paragraph / line breaks → newlines
  t = t.replace(/<(\/p|br|\/div|\/h[1-6]|\/li)[^>]*>/gi, '\n');
  // Drop all remaining tags
  t = t.replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(t);
}

async function readBase64(uri: string): Promise<Uint8Array> {
  const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
  const bin = globalThis.atob ? globalThis.atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToText(bytes: Uint8Array): string {
  // Try UTF-8 first (most epubs/docx use it).
  try {
    if (typeof TextDecoder !== 'undefined') {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  } catch {
    /* fallthrough */
  }
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return s;
}

// ─────────── TXT ───────────
async function extractTxt(uri: string): Promise<string> {
  try {
    return await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
  } catch {
    // Fallback for non-UTF-8 files
    const bytes = await readBase64(uri);
    return bytesToText(bytes);
  }
}

// ─────────── EPUB ───────────
async function extractEpub(uri: string): Promise<string> {
  const bytes = await readBase64(uri);
  const entries = unzipSync(bytes);

  // Determine reading order from OPF if available, otherwise grab all xhtml.
  let spineOrder: string[] = [];
  const opfName = Object.keys(entries).find((n) => /\.opf$/i.test(n));
  if (opfName) {
    const opfText = bytesToText(entries[opfName]);
    const manifest: Record<string, string> = {};
    const itemRe = /<item\s+[^>]*id="([^"]+)"[^>]*href="([^"]+)"[^>]*\/>/gi;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(opfText)) !== null) manifest[m[1]] = m[2];
    const baseDir = opfName.includes('/') ? opfName.slice(0, opfName.lastIndexOf('/') + 1) : '';
    const spineRe = /<itemref\s+[^>]*idref="([^"]+)"/gi;
    while ((m = spineRe.exec(opfText)) !== null) {
      const href = manifest[m[1]];
      if (href) spineOrder.push(baseDir + href);
    }
  }
  if (spineOrder.length === 0) {
    spineOrder = Object.keys(entries).filter((n) => /\.x?html?$/i.test(n)).sort();
  }

  const parts: string[] = [];
  for (const name of spineOrder) {
    const data = entries[name];
    if (!data) continue;
    const html = bytesToText(data);
    const text = stripHtmlTags(html).replace(/[ \t]+/g, ' ').trim();
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

// ─────────── DOCX ───────────
async function extractDocx(uri: string): Promise<string> {
  const bytes = await readBase64(uri);
  const entries = unzipSync(bytes);
  const docXml = entries['word/document.xml'];
  if (!docXml) throw new Error('DOCX non valido: word/document.xml mancante');
  const xml = bytesToText(docXml);

  // Parse paragraphs <w:p>...</w:p>; inside each, concat <w:t>...</w:t> texts.
  const parts: string[] = [];
  const pRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(xml)) !== null) {
    const inner = m[1];
    let line = '';
    const tRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(inner)) !== null) {
      line += decodeHtmlEntities(t[1]);
    }
    // Tab and break elements
    if (/<w:br\b/.test(inner)) line += '\n';
    line = line.trim();
    if (line) parts.push(line);
  }
  return parts.join('\n\n');
}

// ─────────── PDF ───────────
async function extractPdf(uri: string): Promise<string> {
  // pdfjs-dist 3.x CJS build (no import.meta, RN/Hermes friendly).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfjsLib: any = require('pdfjs-dist/legacy/build/pdf.js');
  // Disable worker (RN has no Worker API)
  if (pdfjsLib.GlobalWorkerOptions) pdfjsLib.GlobalWorkerOptions.workerSrc = '';
  const data = await readBase64(uri);
  const doc = await pdfjsLib.getDocument({
    data,
    disableWorker: true,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;

  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Reconstruct text preserving line/paragraph breaks based on Y positions.
    let lastY: number | null = null;
    let line = '';
    const lines: string[] = [];
    for (const item of content.items as any[]) {
      const str: string = item.str || '';
      const y: number | undefined = item.transform?.[5];
      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
        lines.push(line.trimEnd());
        line = '';
      }
      line += str;
      if (item.hasEOL) {
        lines.push(line.trimEnd());
        line = '';
      }
      if (y !== undefined) lastY = y;
    }
    if (line) lines.push(line.trimEnd());
    pages.push(lines.join('\n'));
    try { page.cleanup(); } catch { /* ignore */ }
  }
  try { await doc.cleanup(); } catch { /* ignore */ }
  return pages.join('\n\n');
}

// ─────────── dispatcher ───────────
export async function extractEbook(uri: string, name: string): Promise<string> {
  const ext = (name.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'txt':
      return extractTxt(uri);
    case 'epub':
      return extractEpub(uri);
    case 'docx':
      return extractDocx(uri);
    case 'pdf':
      return extractPdf(uri);
    case 'doc':
      throw new Error(
        '.doc (formato Word legacy) non supportato offline. Apri il file in Word/LibreOffice e salva come .docx, poi ricaricalo.',
      );
    default:
      throw new Error(
        `Formato .${ext} non supportato. Carica .txt .pdf .epub o .docx.`,
      );
  }
}

export const SUPPORTED_MIME_TYPES = [
  'text/plain',
  'application/pdf',
  'application/epub+zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
