// audiobookPlayer.ts — high-level wrapper around expo-audio.
//
// NATIVE-ONLY: Metro picks audiobookPlayer.web.ts on web. On Android / iOS
// the import below is real.
//
// Architecture (post react-native-track-player migration):
//   - We use expo-audio's `createAudioPlayer` (NOT the hook) because the
//     audiobook player is a singleton that outlives any single screen.
//   - One AudioPlayer instance lives for the whole reading session; for
//     each new sentence we call `replace(uri)` instead of recreating the
//     player. This keeps the lock-screen + media notification continuous.
//   - `setActiveForLockScreen(true, meta)` is called ONCE at session
//     start; subsequent sentences only call `updateLockScreenMetadata()`
//     (which is essentially a no-op for our case since title/author do
//     not change between sentences, but harmless).
//
// Per user spec: only Play / Pause on the lockscreen (no Stop). The OS
// notification still has the standard swipe-to-dismiss to fully kill the
// session, which calls our stopPlayback() path via `clearLockScreenControls`
// at the React layer.
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { tracePiper } from './piperEngine';

// ---- Public types --------------------------------------------------------
export type SentenceMetadata = {
  bookTitle: string;
  bookAuthor: string;
  voiceName: string;
  coverUrl?: string | null;
};

type Sub = { remove: () => void };

// ---- Singleton state -----------------------------------------------------
let player: AudioPlayer | null = null;
let modeConfigured = false;
let lockScreenActive = false;
let lastMeta: SentenceMetadata | null = null;

/** Listeners forwarded to PlayerContext.tsx. */
type StateListener = (state: 'playing' | 'paused' | 'finished' | 'idle') => void;
type SimpleListener = () => void;
const stateListeners = new Set<StateListener>();
const remotePauseListeners = new Set<SimpleListener>();
const remotePlayListeners = new Set<SimpleListener>();

let lastPlaying = false;
let lastDidFinish = false;

function notifyState(s: 'playing' | 'paused' | 'finished' | 'idle') {
  stateListeners.forEach((cb) => {
    try { cb(s); } catch { /* ignore */ }
  });
}

function ensurePlayer(): AudioPlayer {
  if (!player) {
    player = createAudioPlayer(null);
    player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      // expo-audio fires this 2x/sec by default. We use the deltas to
      // detect (a) natural end-of-sentence (didJustFinish) and (b) user
      // play/pause taps from the lockscreen (playing flipped while we
      // didn't issue play() / pause() ourselves — see PlayerContext for
      // how those `wasIntentional` flags get reconciled).
      if (status.didJustFinish && !lastDidFinish) {
        lastDidFinish = true;
        notifyState('finished');
      } else if (status.playing !== lastPlaying) {
        lastPlaying = status.playing;
        notifyState(status.playing ? 'playing' : 'paused');
        if (status.playing) {
          remotePlayListeners.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
        } else if (!status.didJustFinish) {
          remotePauseListeners.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
        }
      }
    });
  }
  return player;
}

async function ensureAudioMode(): Promise<void> {
  if (modeConfigured) return;
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      // doNotMix is REQUIRED for setActiveForLockScreen to work correctly.
      interruptionMode: 'doNotMix',
    });
    modeConfigured = true;
    tracePiper('audio.mode', 'configured for background + lockscreen');
  } catch (e: any) {
    tracePiper('audio.mode.err', `${e?.message || e}`);
    throw e;
  }
}

// ---- Public API ----------------------------------------------------------

/**
 * Load a synthesized WAV into the singleton player, attach lockscreen
 * metadata if this is the first call, and start playback. Resolves when
 * the audio finishes naturally OR when an external `stopPlayback()` is
 * called.
 */
export async function playWav(wavPath: string, meta: SentenceMetadata): Promise<void> {
  await ensureAudioMode();
  const p = ensurePlayer();
  const uri = wavPath.startsWith('file://') ? wavPath : `file://${wavPath}`;

  // Reset finish detection for this clip.
  lastDidFinish = false;
  lastPlaying = false;

  // Either replace the current source or set it for the first time.
  // `replace()` triggers a clean re-load of the new file path.
  p.replace(uri);

  // Lockscreen activation: only once per session, then just refresh meta.
  if (!lockScreenActive) {
    try {
      const lockMeta: { title: string; artist: string; albumTitle?: string; artworkUrl?: string } = {
        title: meta.bookTitle || 'Audiobook',
        artist: meta.bookAuthor || '',
      };
      if (meta.voiceName) lockMeta.albumTitle = meta.voiceName;
      if (meta.coverUrl) lockMeta.artworkUrl = meta.coverUrl;
      p.setActiveForLockScreen(true, lockMeta);
      lockScreenActive = true;
      tracePiper('audio.lockscreen.on', `title="${lockMeta.title.slice(0, 40)}"`);
    } catch (e: any) {
      tracePiper('audio.lockscreen.err', `${e?.message || e}`);
    }
  } else if (
    !lastMeta ||
    lastMeta.bookTitle !== meta.bookTitle ||
    lastMeta.bookAuthor !== meta.bookAuthor ||
    lastMeta.coverUrl !== meta.coverUrl
  ) {
    // Different book/author/cover than before — refresh lockscreen.
    try {
      const lockMeta: { title: string; artist: string; albumTitle?: string; artworkUrl?: string } = {
        title: meta.bookTitle || 'Audiobook',
        artist: meta.bookAuthor || '',
      };
      if (meta.voiceName) lockMeta.albumTitle = meta.voiceName;
      if (meta.coverUrl) lockMeta.artworkUrl = meta.coverUrl;
      p.updateLockScreenMetadata(lockMeta);
    } catch { /* ignore */ }
  }
  lastMeta = meta;

  // Start playback.
  p.play();
  tracePiper('audio.play', `path=${uri.slice(uri.lastIndexOf('/') + 1)}`);

  // Wait for natural end or external cancellation.
  return new Promise<void>((resolve) => {
    const remove = onState((s) => {
      if (s === 'finished' || s === 'idle') {
        remove.remove();
        resolve();
      }
    });
  });
}

/** Soft pause — keeps the current source loaded so play() resumes mid-sentence. */
export async function pausePlayback(): Promise<void> {
  if (!player) return;
  try {
    player.pause();
    tracePiper('audio.pause', 'soft');
  } catch (e: any) {
    tracePiper('audio.pause.err', `${e?.message || e}`);
  }
}

/** Resume playback of the current source (must have been paused). */
export async function resumePlayback(): Promise<void> {
  if (!player) return;
  try {
    player.play();
    tracePiper('audio.resume', 'soft');
  } catch (e: any) {
    tracePiper('audio.resume.err', `${e?.message || e}`);
  }
}

/**
 * Hard stop — clears the lock screen, pauses, and frees the source. The
 * AudioPlayer instance is kept for future plays but the lockscreen widget
 * goes away. Use stopAndRelease() to also free the player.
 */
export async function stopPlayback(): Promise<void> {
  if (!player) return;
  try {
    player.pause();
    try { player.clearLockScreenControls(); } catch { /* ignore */ }
    lockScreenActive = false;
    notifyState('idle');
    tracePiper('audio.stop', 'cleared lockscreen');
  } catch (e: any) {
    tracePiper('audio.stop.err', `${e?.message || e}`);
  }
}

/** Tear down completely. Called when the user navigates fully out of audiobook. */
export async function releasePlayer(): Promise<void> {
  if (!player) return;
  try {
    try { player.clearLockScreenControls(); } catch { /* ignore */ }
    try { player.pause(); } catch { /* ignore */ }
    try { player.remove(); } catch { /* ignore */ }
  } finally {
    player = null;
    lockScreenActive = false;
    lastMeta = null;
    modeConfigured = false;
    notifyState('idle');
  }
}

// ---- Subscriptions used by PlayerContext.tsx -----------------------------

export function onState(cb: StateListener): Sub {
  stateListeners.add(cb);
  return { remove: () => { stateListeners.delete(cb); } };
}

export function onRemotePlay(cb: SimpleListener): Sub {
  remotePlayListeners.add(cb);
  return { remove: () => { remotePlayListeners.delete(cb); } };
}

export function onRemotePause(cb: SimpleListener): Sub {
  remotePauseListeners.add(cb);
  return { remove: () => { remotePauseListeners.delete(cb); } };
}

export function isCurrentlyPlaying(): boolean {
  return !!player && lastPlaying;
}
