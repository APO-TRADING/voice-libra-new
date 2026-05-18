// audiobookPlayer.web.ts — Web stub. Metro resolves this file when
// bundling for the web target so we don't even try to load
// react-native-track-player (which is native-only). All exports are
// no-ops; native flow happens only on Android / iOS.

export type SentenceMetadata = {
  bookTitle: string;
  bookAuthor: string;
  voiceName: string;
  coverUrl?: string | null;
};

type Sub = { remove: () => void };

export async function ensureTrackPlayerSetup(): Promise<void> { /* noop */ }
export async function enqueueSentence(_wavPath: string, _meta: SentenceMetadata): Promise<string> { return ''; }
export async function tpPlay(): Promise<void> { /* noop */ }
export async function tpPause(): Promise<void> { /* noop */ }
export async function tpStop(): Promise<void> { /* noop */ }
export async function tpIsPlaying(): Promise<boolean> { return false; }
export async function tpGetQueueSize(): Promise<number> { return 0; }
export function onTrackChanged(_cb: (info: { lastTrackId?: string; nextTrackId?: string }) => void): Sub { return { remove: () => {} }; }
export function onPlaybackState(_cb: (state: any) => void): Sub { return { remove: () => {} }; }
export function onQueueEnded(_cb: () => void): Sub { return { remove: () => {} }; }
export function getStateEnum(): any { return undefined; }
