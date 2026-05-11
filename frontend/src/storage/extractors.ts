// Offline ebook text extractors: PDF, EPUB, DOCX, TXT.
// All pure JavaScript — no native modules, no server.
import * as FileSystem from 'expo-file-system/legacy';
import { unzipSync } from 'fflate';
import { Buffer } from 'buffer';

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
  // Buffer.from(base64) is ~3-4x faster than atob+charCodeAt loop and keeps
  // peak memory low (no extra intermediate binary-string allocation).
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
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
// Hermes (RN's JS engine) is missing several globals that pdfjs-dist 3.x
// touches at module-load time (or in defensive code paths). We polyfill them
// once, lazily, before requiring pdf.js — otherwise loading the module itself
// can throw a hard error or even crash the JS context.
let _pdfjsLoaded: any = null;
function loadPdfjs(): any {
  if (_pdfjsLoaded) return _pdfjsLoaded;
  const g: any = globalThis as any;
  // structuredClone — used by pdfjs internals (33+ references in 3.11).
  if (typeof g.structuredClone !== 'function') {
    g.structuredClone = (val: any) => {
      try { return JSON.parse(JSON.stringify(val)); } catch { return val; }
    };
  }
  // AggregateError — referenced by pdfjs error wrappers; provide a minimal stub.
  if (typeof g.AggregateError !== 'function') {
    g.AggregateError = class AggregateError extends Error {
      errors: any[];
      constructor(errors: any[] = [], message = '') {
        super(message);
        this.name = 'AggregateError';
        this.errors = Array.from(errors || []);
      }
    };
  }
  // Promise.withResolvers — used by some newer pdfjs code paths.
  if (typeof (Promise as any).withResolvers !== 'function') {
    (Promise as any).withResolvers = function () {
      let resolve: any, reject: any;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
  }
  // DOMMatrix / Path2D — only needed for canvas rendering. Provide opaque
  // no-op stubs so any internal feature-detect doesn't blow up.
  if (typeof g.DOMMatrix === 'undefined') g.DOMMatrix = function () { /* stub */ };
  if (typeof g.Path2D === 'undefined') g.Path2D = function () { /* stub */ };

  // pdfjs-dist 3.x CJS build (no import.meta — RN/Hermes friendly).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _pdfjsLoaded = require('pdfjs-dist/legacy/build/pdf.js');
  if (_pdfjsLoaded.GlobalWorkerOptions) _pdfjsLoaded.GlobalWorkerOptions.workerSrc = '';
  return _pdfjsLoaded;
}

async function extractPdf(uri: string): Promise<string> {
  // Refuse pathologically huge files up-front (would OOM the JS heap).
  let fileSize = 0;
  try {
    const info = await FileSystem.getInfoAsync(uri, { size: true } as any);
    fileSize = (info as any)?.size || 0;
  } catch { /* best-effort */ }
  if (fileSize > 80 * 1024 * 1024) {
    throw new Error(`PDF troppo grande (${(fileSize / 1024 / 1024).toFixed(1)} MB). Limite 80 MB.`);
  }

  const pdfjsLib = loadPdfjs();
  const data = await readBase64(uri);

  let doc: any;
  try {
    doc = await pdfjsLib.getDocument({
      data,
      disableWorker: true,
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    }).promise;
  } catch (e: any) {
    throw new Error(`Apertura PDF fallita: ${e?.message || String(e)}`);
  }

  const pages: string[] = [];
  const totalPages = doc.numPages || 0;
  for (let i = 1; i <= totalPages; i++) {
    let page: any = null;
    try {
      page = await doc.getPage(i);
      const content = await page.getTextContent({ disableCombineTextItems: false });
      // Reconstruct text preserving line/paragraph breaks based on Y positions.
      let lastY: number | null = null;
      let line = '';
      const lines: string[] = [];
      for (const item of (content?.items || []) as any[]) {
        const str: string = item?.str ?? '';
        const y: number | undefined = item?.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) {
          if (line) lines.push(line.trimEnd());
          line = '';
        }
        line += str;
        if (item?.hasEOL) {
          lines.push(line.trimEnd());
          line = '';
        }
        if (y !== undefined) lastY = y;
      }
      if (line) lines.push(line.trimEnd());
      pages.push(lines.join('\n'));
    } catch (e: any) {
      // Skip pages we can't decode (e.g. scanned/encrypted), don't crash the whole upload.
      console.warn(`[extractPdf] page ${i} failed:`, e?.message || e);
      pages.push('');
    } finally {
      try { page?.cleanup?.(); } catch { /* ignore */ }
    }
    // Yield to the event loop every 5 pages so the UI thread doesn't ANR.
    if (i % 5 === 0) await new Promise<void>((r) => setTimeout(r, 0));
  }
  try { await doc.cleanup(); } catch { /* ignore */ }
  try { await doc.destroy(); } catch { /* ignore */ }

  const out = pages.join('\n\n').trim();
  if (!out) {
    throw new Error('PDF senza testo estraibile (probabilmente è una scansione di immagini).');
  }
  return out;
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
