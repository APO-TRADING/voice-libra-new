// Local-only library storage.
// - Metadata (book list, folders, progress) → AsyncStorage (small, fast)
// - Per-book content + sentence array → JSON file on disk (no size limits).
//
// Why files for content?
//   Android's AsyncStorage is backed by SQLite which has a per-row
//   CursorWindow limit of ~2 MB. Long EPUBs (or any large novel) easily
//   exceed that and throw "Row too big to fit into CursorWindow".
//   Writing the body to expo-file-system bypasses the limit entirely.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

export type BookSummary = {
  id: string;
  title: string;
  author: string | null;
  cover_url: string | null;
  folder_id: string | null;
  word_count: number;
  sentence_count: number;
  current_sentence_index: number;
  length_scale: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export type BookFull = BookSummary & {
  content: string;
  sentences: string[];
};

export type Folder = { id: string; name: string; created_at: string };

export type SortMode = 'manual' | 'recent' | 'title' | 'author';

const K_BOOKS = '@beppe.books.v1';
const K_FOLDERS = '@beppe.folders.v1';
const K_SORT_MODE = '@beppe.sortMode.v1';
// Legacy key (pre-FS storage). Kept for one-shot migration on read.
const K_BOOK_CONTENT_LEGACY = (id: string) => `@beppe.book.${id}`;

const BOOKS_DIR = `${FileSystem.documentDirectory}books`;
// PATCH (beppe-audiobooks v6.6): split book content into two plain-text
// files instead of a single JSON blob.
//   <id>.txt           — the cleaned full text (raw UTF-8)
//   <id>.sentences.txt — one sentence per line (\n separator)
// Reading two plain files is ~3× faster than parsing megabyte-sized JSON
// because we skip the entire JSON.parse pass; we just split on '\n'.
// Legacy `<id>.json` is auto-migrated on first read.
const bookFilePathLegacyJson = (id: string) => `${BOOKS_DIR}/${id}.json`;
const bookFilePathContent = (id: string) => `${BOOKS_DIR}/${id}.txt`;
const bookFilePathSentences = (id: string) => `${BOOKS_DIR}/${id}.sentences.txt`;

// PATCH (beppe-audiobooks v6.6): in-memory LRU cache of fully-loaded books.
// Once a book is opened, it stays in RAM until the cache evicts it on
// memory pressure (max 10 entries — a typical 800-page novel is ~5MB
// in JS string form, so the cap is ~50MB worst case). Re-opens are
// instant (zero disk I/O, zero JSON.parse).
const BOOK_CACHE_MAX = 10;
const bookCache: Map<string, BookFull> = new Map();
// PATCH (v2.1 — istantaneo): dedupe concurrent prefetch() calls so a quick
// double-tap on a book card doesn't fire two parallel disk reads. Cleared
// as soon as the read completes (success or failure).
const prefetchInFlight: Map<string, Promise<BookFull | null>> = new Map();
function cacheGet(id: string): BookFull | undefined {
  const v = bookCache.get(id);
  if (v) {
    // bump to MRU position
    bookCache.delete(id);
    bookCache.set(id, v);
  }
  return v;
}
function cachePut(id: string, b: BookFull): void {
  if (bookCache.has(id)) bookCache.delete(id);
  bookCache.set(id, b);
  while (bookCache.size > BOOK_CACHE_MAX) {
    // delete the oldest (first inserted) entry
    const firstKey = bookCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    bookCache.delete(firstKey);
  }
}
function cacheInvalidate(id: string): void {
  bookCache.delete(id);
}

async function ensureBooksDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(BOOKS_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(BOOKS_DIR, { intermediates: true });
  }
}

function uuid(): string {
  // RFC4122-ish v4 (cryptographic strength not required here)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

async function loadBooks(): Promise<BookSummary[]> {
  const raw = await AsyncStorage.getItem(K_BOOKS);
  if (!raw) return [];
  const parsed = JSON.parse(raw) as any[];
  return parsed.map(normalize);
}

async function saveBooks(list: BookSummary[]): Promise<void> {
  await AsyncStorage.setItem(K_BOOKS, JSON.stringify(list));
}

async function loadFolders(): Promise<Folder[]> {
  const raw = await AsyncStorage.getItem(K_FOLDERS);
  return raw ? (JSON.parse(raw) as Folder[]) : [];
}

async function saveFolders(list: Folder[]): Promise<void> {
  await AsyncStorage.setItem(K_FOLDERS, JSON.stringify(list));
}

function summary(b: BookSummary): BookSummary {
  return {
    id: b.id,
    title: b.title,
    author: b.author ?? null,
    cover_url: b.cover_url ?? null,
    folder_id: b.folder_id ?? null,
    word_count: b.word_count,
    sentence_count: b.sentence_count,
    current_sentence_index: b.current_sentence_index,
    length_scale: b.length_scale,
    sort_order: b.sort_order ?? 0,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

// Backwards-compatible normalizer: applies sensible defaults to any book
// that was saved BEFORE the `author` / `sort_order` fields existed.
function normalize(b: any): BookSummary {
  return {
    id: b.id,
    title: b.title,
    author: b.author ?? null,
    cover_url: b.cover_url ?? null,
    folder_id: b.folder_id ?? null,
    word_count: b.word_count ?? 0,
    sentence_count: b.sentence_count ?? 0,
    current_sentence_index: b.current_sentence_index ?? 0,
    length_scale: b.length_scale ?? 1.0,
    // Old books → sort_order derived from creation time so the manual
    // order initially matches the chronological one.
    sort_order: typeof b.sort_order === 'number'
      ? b.sort_order
      : (b.created_at ? new Date(b.created_at).getTime() : 0),
    created_at: b.created_at ?? new Date().toISOString(),
    updated_at: b.updated_at ?? b.created_at ?? new Date().toISOString(),
  };
}

async function writeBookContent(id: string, content: string, sentences: string[]): Promise<void> {
  await ensureBooksDir();
  // PATCH (beppe-audiobooks v6.6): write two plain-text files instead of a
  // single JSON blob. Writing UTF-8 directly avoids the JSON-escaping
  // overhead AND lets the reader skip JSON.parse on a several-MB string.
  // Sentences are joined with '\n' — Piper-cleaned sentences never contain
  // a raw newline (the cleaner collapses them), so split('\n') round-trips.
  await FileSystem.writeAsStringAsync(
    bookFilePathContent(id),
    content,
    { encoding: FileSystem.EncodingType.UTF8 },
  );
  await FileSystem.writeAsStringAsync(
    bookFilePathSentences(id),
    sentences.join('\n'),
    { encoding: FileSystem.EncodingType.UTF8 },
  );
}

async function readBookContent(id: string, opts?: { sentencesOnly?: boolean }): Promise<{ content: string; sentences: string[] }> {
  const sentencesOnly = !!opts?.sentencesOnly;
  // 1) Try the NEW v6.6 plain-text format (current default).
  try {
    const ci = await FileSystem.getInfoAsync(bookFilePathContent(id));
    if (ci.exists) {
      if (sentencesOnly) {
        // PATCH (v2.1 — istantaneo): for playback we only need the sentence
        // array, NOT the full content blob. Skipping the .txt read halves
        // the I/O cost on every book-open (the .txt file mirrors the
        // sentences file but as one big string; nothing in the player UI
        // reads `content` after load).
        const sentencesRaw = await FileSystem.readAsStringAsync(
          bookFilePathSentences(id),
          { encoding: FileSystem.EncodingType.UTF8 },
        ).catch(() => '');
        const sentences = sentencesRaw ? sentencesRaw.split('\n') : [];
        return { content: '', sentences };
      }
      const [content, sentencesRaw] = await Promise.all([
        FileSystem.readAsStringAsync(bookFilePathContent(id), {
          encoding: FileSystem.EncodingType.UTF8,
        }),
        FileSystem.readAsStringAsync(bookFilePathSentences(id), {
          encoding: FileSystem.EncodingType.UTF8,
        }).catch(() => ''),
      ]);
      const sentences = sentencesRaw ? sentencesRaw.split('\n') : [];
      return { content, sentences };
    }
  } catch {
    /* fallthrough to legacy migration */
  }
  // 2) Legacy JSON path (v6.5 and older). Migrate to the new format and
  //    delete the old file.
  try {
    const legacyInfo = await FileSystem.getInfoAsync(bookFilePathLegacyJson(id));
    if (legacyInfo.exists) {
      const raw = await FileSystem.readAsStringAsync(bookFilePathLegacyJson(id), {
        encoding: FileSystem.EncodingType.UTF8,
      });
      const parsed = JSON.parse(raw) as { content: string; sentences: string[] };
      try {
        await writeBookContent(id, parsed.content, parsed.sentences);
        await FileSystem.deleteAsync(bookFilePathLegacyJson(id), { idempotent: true });
      } catch {
        /* even if migration write fails, return the data */
      }
      return parsed;
    }
  } catch {
    /* fallthrough to AsyncStorage legacy */
  }
  // 3) Ancient legacy fallback — content used to live in AsyncStorage. If
  //    it's still there, migrate to the new plain-text format and delete
  //    the legacy key.
  try {
    const legacy = await AsyncStorage.getItem(K_BOOK_CONTENT_LEGACY(id));
    if (legacy) {
      const parsed = JSON.parse(legacy) as { content: string; sentences: string[] };
      try {
        await writeBookContent(id, parsed.content, parsed.sentences);
        await AsyncStorage.removeItem(K_BOOK_CONTENT_LEGACY(id));
      } catch {
        /* even if migration write fails, return the data */
      }
      return parsed;
    }
  } catch (e: any) {
    // If AsyncStorage itself throws (e.g. CursorWindow on huge legacy rows),
    // surface a clear error rather than a cryptic SQLite message.
    throw new Error(
      `Contenuto del libro non leggibile (probabilmente troppo grande dalla vecchia versione). ` +
      `Eliminalo dalla libreria e ricaricalo. Dettagli: ${e?.message || e}`,
    );
  }
  throw new Error('Contenuto libro mancante');
}

export const library = {
  async listBooks(folderId?: string): Promise<BookSummary[]> {
    const all = await loadBooks();
    const filtered =
      folderId === undefined
        ? all
        : all.filter((b) => (folderId === 'none' ? !b.folder_id : b.folder_id === folderId));
    return filtered.sort((a, b) => (b.updated_at < a.updated_at ? -1 : 1));
  },

  // Returns books sorted according to the current SortMode. `manual` uses
  // the per-book `sort_order` field (ascending). Other modes are
  // alphabetically computed at read time so the manual order is preserved
  // underneath and can be restored without any data migration.
  async listBooksSorted(opts?: { folderId?: string; mode?: SortMode }): Promise<BookSummary[]> {
    const all = await loadBooks();
    const filtered =
      opts?.folderId === undefined
        ? all
        : all.filter((b) =>
            opts?.folderId === 'none' ? !b.folder_id : b.folder_id === opts?.folderId,
          );
    const mode = opts?.mode || (await library.getSortMode());
    const arr = [...filtered];
    switch (mode) {
      case 'manual':
        arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        break;
      case 'title':
        arr.sort((a, b) => a.title.localeCompare(b.title, 'it', { sensitivity: 'base' }));
        break;
      case 'author':
        arr.sort((a, b) => {
          const aa = (a.author || '').trim();
          const bb = (b.author || '').trim();
          // books without an author go to the bottom
          if (!aa && bb) return 1;
          if (aa && !bb) return -1;
          const cmp = aa.localeCompare(bb, 'it', { sensitivity: 'base' });
          if (cmp !== 0) return cmp;
          return a.title.localeCompare(b.title, 'it', { sensitivity: 'base' });
        });
        break;
      case 'recent':
      default:
        arr.sort((a, b) => (b.updated_at < a.updated_at ? -1 : 1));
        break;
    }
    return arr;
  },

  async getSortMode(): Promise<SortMode> {
    const raw = await AsyncStorage.getItem(K_SORT_MODE);
    if (raw === 'manual' || raw === 'recent' || raw === 'title' || raw === 'author') return raw;
    return 'recent';
  },

  async setSortMode(mode: SortMode): Promise<void> {
    await AsyncStorage.setItem(K_SORT_MODE, mode);
  },

  // Re-orders books by assigning incremental sort_order values in the
  // exact sequence given. Only the IDs present in `orderedIds` are
  // rewritten; everything else is left in its previous position. This
  // means re-ordering inside a folder doesn't disturb the order of books
  // in other folders.
  async reorderBooks(orderedIds: string[]): Promise<void> {
    const list = await loadBooks();
    // Find the maximum existing sort_order outside this subset so we don't
    // collide; new values start above that floor.
    const subset = new Set(orderedIds);
    const outside = list.filter((b) => !subset.has(b.id));
    const maxOutside = outside.reduce((m, b) => Math.max(m, b.sort_order ?? 0), 0);
    // Use a 100-step gap so insertion between two books later doesn't
    // require renumbering everything.
    const base = Math.floor(maxOutside / 100) * 100 + 100;
    orderedIds.forEach((id, i) => {
      const idx = list.findIndex((b) => b.id === id);
      if (idx >= 0) list[idx].sort_order = base + (i + 1) * 100;
    });
    await saveBooks(list);
  },

  async getBook(id: string): Promise<BookFull> {
    // PATCH (beppe-audiobooks v6.6): consult the in-memory cache FIRST.
    // If the same book was already loaded (e.g. user navigated away from
    // the player and is now coming back), return instantly with zero
    // disk I/O. Cache is populated on the first miss below.
    const cached = cacheGet(id);
    if (cached) {
      // Always refresh the metadata view (progress, length_scale, title,
      // etc. might have been updated by the player in the meantime via
      // updateProgress / updateBook).
      const list = await loadBooks();
      const meta = list.find((x) => x.id === id);
      if (meta) {
        const refreshed: BookFull = {
          ...meta,
          content: cached.content,
          sentences: cached.sentences,
        };
        cachePut(id, refreshed);
        return refreshed;
      }
    }
    const list = await loadBooks();
    const b = list.find((x) => x.id === id);
    if (!b) throw new Error('Libro non trovato');
    // PATCH (v2.1 — istantaneo): read ONLY the sentence array. The .txt
    // full-content blob is unused by the player UI; skipping it cuts the
    // book-open I/O time roughly in half on multi-MB novels. We still
    // honor the legacy migration path inside readBookContent (it will
    // upgrade old JSON/AsyncStorage layouts on first read).
    const { content, sentences } = await readBookContent(id, { sentencesOnly: true });
    const full: BookFull = { ...b, content, sentences };
    cachePut(id, full);
    return full;
  },

  /**
   * Fire-and-forget cache warm-up. Called from BookList card press so the
   * sentences are already in RAM by the time the player screen mounts and
   * runs getBook(). Safe to call multiple times — the cache and the in-
   * flight tracker dedupe concurrent calls.
   *
   * Returns the cached BookFull on success, null on failure. Errors are
   * intentionally swallowed (this is a UX hint, not a critical path).
   */
  async prefetchBook(id: string): Promise<BookFull | null> {
    try {
      if (bookCache.has(id)) return bookCache.get(id) || null;
      if (prefetchInFlight.has(id)) {
        try { await prefetchInFlight.get(id); } catch { /* ignore */ }
        return bookCache.get(id) || null;
      }
      const p = (async () => {
        try {
          return await library.getBook(id);
        } catch {
          return null;
        }
      })();
      prefetchInFlight.set(id, p);
      const result = await p;
      prefetchInFlight.delete(id);
      return result;
    } catch {
      prefetchInFlight.delete(id);
      return null;
    }
  },

  async addBook(input: {
    title: string;
    author?: string | null;
    cover_url?: string | null;
    folder_id?: string | null;
    content: string;
    sentences: string[];
    word_count: number;
  }): Promise<BookSummary> {
    const list = await loadBooks();
    const now = nowIso();
    // New books always go FIRST in the manual order (lowest sort_order).
    const minSort = list.reduce(
      (m, b) => Math.min(m, b.sort_order ?? Number.POSITIVE_INFINITY),
      Number.POSITIVE_INFINITY,
    );
    const sortOrder = Number.isFinite(minSort) ? minSort - 100 : Date.now();
    const book: BookSummary = {
      id: uuid(),
      title: input.title,
      author: (input.author || '').trim() || null,
      cover_url: input.cover_url ?? null,
      folder_id: input.folder_id ?? null,
      word_count: input.word_count,
      sentence_count: input.sentences.length,
      current_sentence_index: 0,
      length_scale: 1.0,
      sort_order: sortOrder,
      created_at: now,
      updated_at: now,
    };
    // Write content to FS first; if that fails we don't want a metadata
    // entry pointing to non-existent content.
    await writeBookContent(book.id, input.content, input.sentences);
    list.unshift(book);
    await saveBooks(list);
    // PATCH (beppe-audiobooks v6.6): preload the cache so the very next
    // open of this book is instant (no disk round-trip).
    cachePut(book.id, { ...book, content: input.content, sentences: input.sentences });
    return summary(book);
  },

  async updateBook(
    id: string,
    patch: Partial<{
      title: string;
      author: string | null;
      cover_url: string | null;
      folder_id: string | null;
      length_scale: number;
      sort_order: number;
    }>,
  ): Promise<BookSummary> {
    const list = await loadBooks();
    const idx = list.findIndex((b) => b.id === id);
    if (idx < 0) throw new Error('Libro non trovato');
    const b = list[idx];
    if (patch.title !== undefined) b.title = patch.title;
    if (patch.author !== undefined) b.author = (patch.author || '').trim() || null;
    if (patch.cover_url !== undefined) b.cover_url = patch.cover_url;
    if (patch.folder_id !== undefined) b.folder_id = patch.folder_id;
    if (patch.length_scale !== undefined) b.length_scale = Math.max(0.5, Math.min(2.0, patch.length_scale));
    if (patch.sort_order !== undefined) b.sort_order = patch.sort_order;
    b.updated_at = nowIso();
    list[idx] = b;
    await saveBooks(list);
    // PATCH (beppe-audiobooks v6.6): update the cached BookFull metadata
    // in place so the cached entry keeps the new title/author/cover/etc.
    // (content + sentences are unchanged so we reuse them).
    const cached = bookCache.get(id);
    if (cached) {
      cachePut(id, { ...cached, ...summary(b) });
    }
    return summary(b);
  },

  async updateProgress(id: string, current_sentence_index: number): Promise<BookSummary> {
    const list = await loadBooks();
    const idx = list.findIndex((b) => b.id === id);
    if (idx < 0) throw new Error('Libro non trovato');
    const b = list[idx];
    const clamped = Math.max(0, Math.min(current_sentence_index, Math.max(0, b.sentence_count - 1)));
    b.current_sentence_index = clamped;
    b.updated_at = nowIso();
    list[idx] = b;
    await saveBooks(list);
    // PATCH (beppe-audiobooks v6.6): update the cached BookFull progress
    // pointer too, so the next getBook() doesn't return a stale index.
    const cached = bookCache.get(id);
    if (cached) {
      cachePut(id, { ...cached, current_sentence_index: clamped, updated_at: b.updated_at });
    }
    return summary(b);
  },

  async deleteBook(id: string): Promise<void> {
    const list = await loadBooks();
    const filtered = list.filter((b) => b.id !== id);
    await saveBooks(filtered);
    // Clean every possible storage location (v6.6 plain-text, v6.5 JSON
    // and ancient AsyncStorage rows).
    try { await FileSystem.deleteAsync(bookFilePathContent(id), { idempotent: true }); } catch { /* ignore */ }
    try { await FileSystem.deleteAsync(bookFilePathSentences(id), { idempotent: true }); } catch { /* ignore */ }
    try { await FileSystem.deleteAsync(bookFilePathLegacyJson(id), { idempotent: true }); } catch { /* ignore */ }
    try { await AsyncStorage.removeItem(K_BOOK_CONTENT_LEGACY(id)); } catch { /* ignore */ }
    // PATCH (beppe-audiobooks v6.6): drop the in-memory cache entry too.
    cacheInvalidate(id);
  },

  async listFolders(): Promise<Folder[]> {
    const list = await loadFolders();
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  },

  async getFolder(id: string): Promise<Folder | null> {
    const list = await loadFolders();
    return list.find((f) => f.id === id) || null;
  },

  async createFolder(name: string): Promise<Folder> {
    const n = name.trim();
    if (!n) throw new Error('Nome cartella obbligatorio');
    const list = await loadFolders();
    const f: Folder = { id: uuid(), name: n, created_at: nowIso() };
    list.push(f);
    await saveFolders(list);
    return f;
  },

  async updateFolder(id: string, name: string): Promise<Folder> {
    const n = name.trim();
    if (!n) throw new Error('Nome cartella obbligatorio');
    const list = await loadFolders();
    const idx = list.findIndex((f) => f.id === id);
    if (idx < 0) throw new Error('Cartella non trovata');
    list[idx].name = n;
    await saveFolders(list);
    return list[idx];
  },

  async deleteFolder(id: string): Promise<void> {
    const list = await loadFolders();
    await saveFolders(list.filter((f) => f.id !== id));
    // Detach books
    const books = await loadBooks();
    let changed = false;
    for (const b of books) {
      if (b.folder_id === id) {
        b.folder_id = null;
        changed = true;
      }
    }
    if (changed) await saveBooks(books);
  },
};
