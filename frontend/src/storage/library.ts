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
  cover_url: string | null;
  folder_id: string | null;
  word_count: number;
  sentence_count: number;
  current_sentence_index: number;
  length_scale: number;
  created_at: string;
  updated_at: string;
};

export type BookFull = BookSummary & {
  content: string;
  sentences: string[];
};

export type Folder = { id: string; name: string; created_at: string };

const K_BOOKS = '@beppe.books.v1';
const K_FOLDERS = '@beppe.folders.v1';
// Legacy key (pre-FS storage). Kept for one-shot migration on read.
const K_BOOK_CONTENT_LEGACY = (id: string) => `@beppe.book.${id}`;

const BOOKS_DIR = `${FileSystem.documentDirectory}books`;
const bookFilePath = (id: string) => `${BOOKS_DIR}/${id}.json`;

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
  return raw ? (JSON.parse(raw) as BookSummary[]) : [];
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
    cover_url: b.cover_url ?? null,
    folder_id: b.folder_id ?? null,
    word_count: b.word_count,
    sentence_count: b.sentence_count,
    current_sentence_index: b.current_sentence_index,
    length_scale: b.length_scale,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

async function writeBookContent(id: string, content: string, sentences: string[]): Promise<void> {
  await ensureBooksDir();
  await FileSystem.writeAsStringAsync(
    bookFilePath(id),
    JSON.stringify({ content, sentences }),
    { encoding: FileSystem.EncodingType.UTF8 },
  );
}

async function readBookContent(id: string): Promise<{ content: string; sentences: string[] }> {
  // 1) Try the FS path (current default).
  try {
    const info = await FileSystem.getInfoAsync(bookFilePath(id));
    if (info.exists) {
      const raw = await FileSystem.readAsStringAsync(bookFilePath(id), {
        encoding: FileSystem.EncodingType.UTF8,
      });
      return JSON.parse(raw) as { content: string; sentences: string[] };
    }
  } catch {
    /* fallthrough to legacy migration */
  }
  // 2) Legacy fallback — content used to live in AsyncStorage. If it's still
  //    there, migrate to FS and delete the legacy key.
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

  async getBook(id: string): Promise<BookFull> {
    const list = await loadBooks();
    const b = list.find((x) => x.id === id);
    if (!b) throw new Error('Libro non trovato');
    const { content, sentences } = await readBookContent(id);
    return { ...b, content, sentences };
  },

  async addBook(input: {
    title: string;
    cover_url?: string | null;
    folder_id?: string | null;
    content: string;
    sentences: string[];
    word_count: number;
  }): Promise<BookSummary> {
    const list = await loadBooks();
    const now = nowIso();
    const book: BookSummary = {
      id: uuid(),
      title: input.title,
      cover_url: input.cover_url ?? null,
      folder_id: input.folder_id ?? null,
      word_count: input.word_count,
      sentence_count: input.sentences.length,
      current_sentence_index: 0,
      length_scale: 1.0,
      created_at: now,
      updated_at: now,
    };
    // Write content to FS first; if that fails we don't want a metadata
    // entry pointing to non-existent content.
    await writeBookContent(book.id, input.content, input.sentences);
    list.unshift(book);
    await saveBooks(list);
    return summary(book);
  },

  async updateBook(
    id: string,
    patch: Partial<{ title: string; cover_url: string | null; folder_id: string | null; length_scale: number }>,
  ): Promise<BookSummary> {
    const list = await loadBooks();
    const idx = list.findIndex((b) => b.id === id);
    if (idx < 0) throw new Error('Libro non trovato');
    const b = list[idx];
    if (patch.title !== undefined) b.title = patch.title;
    if (patch.cover_url !== undefined) b.cover_url = patch.cover_url;
    if (patch.folder_id !== undefined) b.folder_id = patch.folder_id;
    if (patch.length_scale !== undefined) b.length_scale = Math.max(0.5, Math.min(2.0, patch.length_scale));
    b.updated_at = nowIso();
    list[idx] = b;
    await saveBooks(list);
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
    return summary(b);
  },

  async deleteBook(id: string): Promise<void> {
    const list = await loadBooks();
    const filtered = list.filter((b) => b.id !== id);
    await saveBooks(filtered);
    // Clean both possible storage locations.
    try { await FileSystem.deleteAsync(bookFilePath(id), { idempotent: true }); } catch { /* ignore */ }
    try { await AsyncStorage.removeItem(K_BOOK_CONTENT_LEGACY(id)); } catch { /* ignore */ }
  },

  async listFolders(): Promise<Folder[]> {
    const list = await loadFolders();
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
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
