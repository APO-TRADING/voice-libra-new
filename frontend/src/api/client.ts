// API client for Beppe Audiobooks backend.
const BASE = process.env.EXPO_PUBLIC_BACKEND_URL || '';

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

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export const api = {
  listBooks: (folderId?: string) => {
    const q = folderId !== undefined ? `?folder_id=${encodeURIComponent(folderId)}` : '';
    return jsonFetch<BookSummary[]>(`/api/books${q}`);
  },
  getBook: (id: string) => jsonFetch<BookFull>(`/api/books/${id}`),
  updateBook: (id: string, body: Partial<{ title: string; cover_url: string | null; folder_id: string | null; length_scale: number }>) =>
    jsonFetch<BookSummary>(`/api/books/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateProgress: (id: string, current_sentence_index: number) =>
    jsonFetch<BookSummary>(`/api/books/${id}/progress`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_sentence_index }),
    }),
  deleteBook: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/books/${id}`, { method: 'DELETE' }),

  uploadBook: async (file: { uri: string; name: string; mimeType?: string }, opts?: { title?: string; cover_url?: string; folder_id?: string }) => {
    const form = new FormData();
    // @ts-expect-error RN FormData file shape
    form.append('file', { uri: file.uri, name: file.name, type: file.mimeType || 'application/octet-stream' });
    if (opts?.title) form.append('title', opts.title);
    if (opts?.cover_url) form.append('cover_url', opts.cover_url);
    if (opts?.folder_id) form.append('folder_id', opts.folder_id);
    const res = await fetch(`${BASE}/api/books/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
    return (await res.json()) as BookSummary;
  },

  listFolders: () => jsonFetch<Folder[]>('/api/folders'),
  createFolder: (name: string) =>
    jsonFetch<Folder>('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  updateFolder: (id: string, name: string) =>
    jsonFetch<Folder>(`/api/folders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  deleteFolder: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/api/folders/${id}`, { method: 'DELETE' }),
};
