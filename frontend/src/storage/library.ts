// Local-only library storage using AsyncStorage. No backend needed.
// All books, folders, and progress live on-device.
import AsyncStorage from '@react-native-async-storage/async-storage';

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
const K_BOOK_CONTENT = (id: string) => `@beppe.book.${id}`;

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
    const raw = await AsyncStorage.getItem(K_BOOK_CONTENT(id));
    if (!raw) throw new Error('Contenuto libro mancante');
    const { content, sentences } = JSON.parse(raw) as { content: string; sentences: string[] };
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
    list.unshift(book);
    await saveBooks(list);
    await AsyncStorage.setItem(
      K_BOOK_CONTENT(book.id),
      JSON.stringify({ content: input.content, sentences: input.sentences }),
    );
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
    await AsyncStorage.removeItem(K_BOOK_CONTENT(id));
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
