// audiobookPlayer.web.ts — Web stub.
// Metro resolves this file when bundling for web. We don't load
// expo-audio on web; the player is no-op.

export type SentenceMetadata = {
  bookTitle: string;
  bookAuthor: string;
  voiceName: string;
  coverUrl?: string | null;
};

type Sub = { remove: () => void };

export async function playWav(_wavPath: string, _meta: SentenceMetadata): Promise<void> { /* noop */ }
export async function pausePlayback(): Promise<void> { /* noop */ }
export async function resumePlayback(): Promise<void> { /* noop */ }
export async function stopPlayback(): Promise<void> { /* noop */ }
export async function releasePlayer(): Promise<void> { /* noop */ }
export function onState(_cb: (s: 'playing' | 'paused' | 'finished' | 'idle') => void): Sub { return { remove: () => {} }; }
export function onRemotePlay(_cb: () => void): Sub { return { remove: () => {} }; }
export function onRemotePause(_cb: () => void): Sub { return { remove: () => {} }; }
export function isCurrentlyPlaying(): boolean { return false; }
