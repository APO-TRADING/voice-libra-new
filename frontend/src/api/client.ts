// API facade — 100% local (no backend). Reads the picked file, extracts text
// (PDF/EPUB/DOCX/TXT), cleans, splits sentences, stores in AsyncStorage.
import {
  library,
  type BookSummary as LBookSummary,
  type BookFull as LBookFull,
  type Folder as LFolder,
  type SortMode as LSortMode,
} from '../storage/library';
import { extractEbook } from '../storage/extractors';
import { cleanText, countWords, splitSentences } from '../storage/textProcessor';

export type BookSummary = LBookSummary;
export type BookFull = LBookFull;
export type Folder = LFolder;
export type SortMode = LSortMode;

export const api = {
  listBooks: (folderId?: string) => library.listBooks(folderId),
  // Pre-fill the in-memory book cache so the player screen mounts
  // instantly. Fire-and-forget — callers should NOT await this.
  prefetchBook: (id: string) => library.prefetchBook(id),
  // Returns books sorted according to the user's current preference (or
  // `mode` if provided). Pass folderId='none' to filter to books NOT in
  // any folder, or a specific folder ID to filter to that folder.
  listBooksSorted: (opts?: { folderId?: string; mode?: SortMode }) =>
    library.listBooksSorted(opts),
  getBook: (id: string) => library.getBook(id),
  updateBook: (
    id: string,
    body: Partial<{
      title: string;
      author: string | null;
      cover_url: string | null;
      folder_id: string | null;
      length_scale: number;
      sort_order: number;
    }>,
  ) => library.updateBook(id, body),
  updateProgress: (id: string, current_sentence_index: number) =>
    library.updateProgress(id, current_sentence_index),
  deleteBook: async (id: string) => {
    await library.deleteBook(id);
    return { ok: true };
  },

  uploadBook: async (
    file: { uri: string; name: string; mimeType?: string },
    opts?: { title?: string; author?: string; cover_url?: string; folder_id?: string },
  ): Promise<BookSummary> => {
    const raw = await extractEbook(file.uri, file.name);
    const cleaned = cleanText(raw);
    const sentences = splitSentences(cleaned);
    if (sentences.length === 0) {
      throw new Error('Documento vuoto dopo la pulizia');
    }
    const fallbackTitle = file.name.replace(/\.[^.]+$/, '') || 'Senza titolo';
    return library.addBook({
      title: (opts?.title?.trim() || fallbackTitle).slice(0, 200),
      author: opts?.author?.trim() || null,
      cover_url: opts?.cover_url || null,
      folder_id: opts?.folder_id || null,
      content: cleaned,
      sentences,
      word_count: countWords(cleaned),
    });
  },

  listFolders: () => library.listFolders(),
  getFolder: (id: string) => library.getFolder(id),
  createFolder: (name: string) => library.createFolder(name),
  updateFolder: (id: string, name: string) => library.updateFolder(id, name),
  deleteFolder: async (id: string) => {
    await library.deleteFolder(id);
    return { ok: true };
  },

  // Sort preference
  getSortMode: () => library.getSortMode(),
  setSortMode: (mode: SortMode) => library.setSortMode(mode),
  reorderBooks: (orderedIds: string[]) => library.reorderBooks(orderedIds),
};
