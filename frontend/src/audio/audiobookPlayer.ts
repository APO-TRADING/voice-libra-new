// audiobookPlayer.ts — high-level wrapper around expo-audio.
//
// NATIVE-ONLY: Metro picks audiobookPlayer.web.ts on web. On Android / iOS
// the import below is real.
//
// Architecture (v2.2, post react-native-track-player migration):
//   - One AudioPlayer instance PER SENTENCE. We re-create it on every
//     playWav() call. The previous design re-used a singleton + replace()
//     but expo-audio's Android ExoPlayer occasionally stalled when
//     replace() was called immediately after a `didJustFinish` event
//     (10+ second delays were observed in production logs). Re-creating
//     the player guarantees a clean, "loaded" state with the source
//     already attached in the constructor — play() returns instantly.
//   - The MediaSession (lockscreen) is re-bound to the new player via
//     setActiveForLockScreen(true, meta) on every sentence. On Android
//     this is a single binder call (<10ms) and the lockscreen widget
//     never disappears between sentences because the OS keeps the
//     notification while a new player takes over.
//   - The previous player is .remove()'d AFTER the new one has been
//     created (and ideally after the new audio has started), so there
//     is no gap. We also call .pause() on the old player to break any
//     internal ExoPlayer queue before disposing.
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

// PATCH (v2.4): we drive expo-audio with our own play/pause commands and
// the underlying player ALSO fires a `playbackStatusUpdate` whenever the
// playing flag flips. Without these debounce timestamps, every internal
// p.play() call would be misclassified as a "lockscreen tap" from the
// user and bounce back through remotePlayListeners → a feedback loop that
// in the v2.2 log showed up as ~50 spurious `remote.play` events per book.
//
// We record the wall-clock time of EVERY self-initiated state change and
// the playbackStatusUpdate listener ignores remote callbacks while inside
// the debounce window. 350 ms is more than the longest gap we ever saw
// between p.play() and the listener firing (typically 80–200 ms on a
// Realme Dimensity).
let lastSelfPlayMs = 0;
let lastSelfPauseMs = 0;
const SELF_EVENT_DEBOUNCE_MS = 350;

function notifyState(s: 'playing' | 'paused' | 'finished' | 'idle') {
  stateListeners.forEach((cb) => {
    try { cb(s); } catch { /* ignore */ }
  });
}

function attachListenersTo(p: AudioPlayer): void {
  p.addListener('playbackStatusUpdate', (status: AudioStatus) => {
    // expo-audio fires this 2x/sec by default. We use the deltas to
    // detect (a) natural end-of-sentence (didJustFinish) and (b) user
    // play/pause taps from the lockscreen (playing flipped while we
    // didn't issue play() / pause() ourselves).
    if (status.didJustFinish && !lastDidFinish) {
      lastDidFinish = true;
      notifyState('finished');
    } else if (status.playing !== lastPlaying) {
      lastPlaying = status.playing;
      notifyState(status.playing ? 'playing' : 'paused');
      const now = Date.now();
      if (status.playing) {
        // v2.4: skip remote.play emission if this is the echo of our own
        // recent play() call.
        if (now - lastSelfPlayMs >= SELF_EVENT_DEBOUNCE_MS) {
          remotePlayListeners.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
        }
      } else if (!status.didJustFinish) {
        if (now - lastSelfPauseMs >= SELF_EVENT_DEBOUNCE_MS) {
          remotePauseListeners.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
        }
      }
    }
  });
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
 * Load a synthesized WAV into a fresh AudioPlayer instance, attach
 * lockscreen metadata, and start playback. Resolves when the audio
 * finishes naturally OR when an external `stopPlayback()` is called.
 *
 * v2.4 (memory leak fix): one AudioPlayer instance lives at a time. We
 * SYNCHRONOUSLY tear down the previous instance (.pause() + .remove())
 * BEFORE the new instance starts playing. This guarantees zero RAM
 * accumulation across hours-long reading sessions.
 *
 * The previous v2.2 design used `setTimeout(() => previous.remove(), 50)`
 * to avoid a brief lockscreen flicker, but in production logs we saw the
 * AudioPlayer ID-set grow to 50+ instances for a 6-minute reading session
 * (one per sentence) — clear memory leak.
 *
 * The lockscreen continues to look continuous because we explicitly
 * transfer the MediaSession to the new player (setActiveForLockScreen on
 * the new instance) BEFORE killing the old one — the OS retains the
 * notification widget when ownership transfers atomically.
 */
export async function playWav(wavPath: string, meta: SentenceMetadata): Promise<void> {
  await ensureAudioMode();
  const uri = wavPath.startsWith('file://') ? wavPath : `file://${wavPath}`;

  // Reset finish detection for the new clip.
  lastDidFinish = false;
  lastPlaying = false;

  // Snapshot the previous player so we can dispose it AFTER the new one
  // is fully wired and owning the MediaSession. We must NOT touch it
  // before that, otherwise the OS notification briefly disappears.
  const previous = player;

  // Build the new player with source attached in the constructor.
  // ExoPlayer prepares synchronously on file:// URIs, so by the time
  // play() is called the source is ready to stream.
  const p = createAudioPlayer({ uri });
  attachListenersTo(p);

  // v2.4: explicit MediaSession handoff. On strict Android implementations
  // the OS may briefly show "no audio session" if two players try to claim
  // the lockscreen at the same instant. We release the previous first.
  if (previous) {
    try { previous.setActiveForLockScreen(false); } catch { /* ignore */ }
  }

  // Transfer the MediaSession ownership BEFORE we kill the old player.
  try {
    const lockMeta: { title: string; artist: string; albumTitle?: string; artworkUrl?: string } = {
      title: meta.bookTitle || 'Audiobook',
      artist: meta.bookAuthor || '',
    };
    if (meta.voiceName) lockMeta.albumTitle = meta.voiceName;
    if (meta.coverUrl) lockMeta.artworkUrl = meta.coverUrl;
    p.setActiveForLockScreen(true, lockMeta);
    if (!lockScreenActive) {
      tracePiper('audio.lockscreen.on', `title="${lockMeta.title.slice(0, 100)}"`);
      lockScreenActive = true;
    }
    lastMeta = meta;
  } catch (e: any) {
    tracePiper('audio.lockscreen.err', `${e?.message || e}`);
  }

  // Atomically swap the module-level player reference and start playback.
  player = p;
  // v2.4: mark THIS exact moment as a self-initiated play so the
  // playbackStatusUpdate listener doesn't echo it back as `remote.play`.
  lastSelfPlayMs = Date.now();
  p.play();
  tracePiper('audio.player.create', `id=${(p as any).id ?? '?'} loaded=${p.isLoaded ?? '?'}`);
  tracePiper('audio.play', `path=${uri.slice(uri.lastIndexOf('/') + 1)}`);

  // NOW that the new player owns the MediaSession and is playing, kill the
  // previous one IMMEDIATELY. expo-audio's .remove() is synchronous: it
  // detaches all listeners, releases the underlying ExoPlayer, and frees
  // the audio buffer. No setTimeout — no RAM growth.
  if (previous) {
    try { previous.pause(); } catch { /* ignore */ }
    try { previous.remove(); } catch { /* ignore */ }
  }

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
    // v2.4: mark this as a self-initiated pause so the listener doesn't
    // echo it back as `remote.pause`.
    lastSelfPauseMs = Date.now();
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
    // v2.4: mark this as a self-initiated play so the listener doesn't
    // echo it back as `remote.play`.
    lastSelfPlayMs = Date.now();
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
    // v2.4: pause IS self-initiated here; suppress the echo.
    lastSelfPauseMs = Date.now();
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
