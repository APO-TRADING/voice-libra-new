// API facade — 100% local (no backend). Reads the picked file, extracts text
// (PDF/EPUB/DOCX/TXT), cleans, splits sentences, stores in AsyncStorage.
import { library, type BookSummary as LBookSummary, type BookFull as LBookFull, type Folder as LFolder } from '../storage/library';
import { extractEbook } from '../storage/extractors';
import { cleanText, countWords, splitSentences } from '../storage/textProcessor';

export type BookSummary = LBookSummary;
export type BookFull = LBookFull;
export type Folder = LFolder;

export const api = {
  listBooks: (folderId?: string) => library.listBooks(folderId),
  getBook: (id: string) => library.getBook(id),
  updateBook: (id: string, body: Partial<{ title: string; cover_url: string | null; folder_id: string | null; length_scale: number }>) =>
    library.updateBook(id, body),
  updateProgress: (id: string, current_sentence_index: number) =>
    library.updateProgress(id, current_sentence_index),
  deleteBook: async (id: string) => {
    await library.deleteBook(id);
    return { ok: true };
  },

  uploadBook: async (
    file: { uri: string; name: string; mimeType?: string },
    opts?: { title?: string; cover_url?: string; folder_id?: string },
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
      cover_url: opts?.cover_url || null,
      folder_id: opts?.folder_id || null,
      content: cleaned,
      sentences,
      word_count: countWords(cleaned),
    });
  },

  listFolders: () => library.listFolders(),
  createFolder: (name: string) => library.createFolder(name),
  updateFolder: (id: string, name: string) => library.updateFolder(id, name),
  deleteFolder: async (id: string) => {
    await library.deleteFolder(id);
    return { ok: true };
  },
};
