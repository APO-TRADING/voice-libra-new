// audiobookPlayer.ts — high-level wrapper around react-native-track-player.
//
// NATIVE-ONLY: Metro picks audiobookPlayer.web.ts on web. On Android / iOS
// the import below is real.
//
// Per user spec: ONLY Play / Pause / Stop on the lockscreen. The metadata
// displayed there is book title + author + voice — NEVER the sentence text.
import TrackPlayer, { Capability, Event, State, type Track } from 'react-native-track-player';
import { tracePiper } from './piperEngine';

// ---- Setup ---------------------------------------------------------------
let setupDone = false;
let setupPromise: Promise<void> | null = null;

export async function ensureTrackPlayerSetup(): Promise<void> {
  if (setupDone) return;
  if (setupPromise) return setupPromise;
  setupPromise = (async () => {
    try {
      tracePiper('tp.setup', 'begin');
      await TrackPlayer.setupPlayer({
        maxBuffer: 50 * 1024 * 1024,
      });
      await TrackPlayer.updateOptions({
        capabilities: [Capability.Play, Capability.Pause, Capability.Stop],
        compactCapabilities: [Capability.Play, Capability.Pause],
        notificationCapabilities: [Capability.Play, Capability.Pause, Capability.Stop],
        android: { alwaysPauseOnInterruption: false },
      });
      setupDone = true;
      tracePiper('tp.setup', 'ok');
    } catch (e: any) {
      tracePiper('tp.setup.err', `${e?.message || e}`);
      throw e;
    } finally {
      setupPromise = null;
    }
  })();
  return setupPromise;
}

// ---- Public API ----------------------------------------------------------
export type SentenceMetadata = {
  bookTitle: string;
  bookAuthor: string;
  voiceName: string;
  coverUrl?: string | null;
};

let trackCounter = 0;

export async function enqueueSentence(
  wavPath: string,
  meta: SentenceMetadata,
): Promise<string> {
  await ensureTrackPlayerSetup();
  trackCounter += 1;
  const id = `s_${Date.now()}_${trackCounter}`;
  const track: Track = {
    id,
    url: wavPath.startsWith('file://') ? wavPath : 'file://' + wavPath,
    title: meta.bookTitle || 'Audiobook',
    artist: meta.bookAuthor || 'Beppe Audiobooks',
    album: meta.voiceName ? `Voce: ${meta.voiceName}` : 'Beppe Audiobooks',
    artwork: meta.coverUrl || undefined,
  };
  await TrackPlayer.add(track);
  return id;
}

export async function tpPlay(): Promise<void> {
  await ensureTrackPlayerSetup();
  await TrackPlayer.play();
}

export async function tpPause(): Promise<void> {
  try { await TrackPlayer.pause(); } catch { /* ignore */ }
}

export async function tpStop(): Promise<void> {
  try { await TrackPlayer.reset(); } catch { /* ignore */ }
}

export async function tpIsPlaying(): Promise<boolean> {
  try {
    const state = await TrackPlayer.getPlaybackState();
    return state.state === State.Playing || state.state === State.Buffering;
  } catch { return false; }
}

export async function tpGetQueueSize(): Promise<number> {
  try { return (await TrackPlayer.getQueue()).length; } catch { return 0; }
}

type Sub = { remove: () => void };

export function onTrackChanged(cb: (info: { lastTrackId?: string; nextTrackId?: string }) => void): Sub {
  const sub = TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, (data: any) => {
    const lastId = data?.lastTrack?.id ?? data?.lastTrack ?? undefined;
    const nextId = data?.track?.id ?? data?.track ?? undefined;
    cb({ lastTrackId: lastId, nextTrackId: nextId });
  });
  return { remove: () => { try { (sub as any)?.remove?.(); } catch { /* ignore */ } } };
}

export function onPlaybackState(cb: (state: State) => void): Sub {
  const sub = TrackPlayer.addEventListener(Event.PlaybackState, (data: any) => cb(data?.state as State));
  return { remove: () => { try { (sub as any)?.remove?.(); } catch { /* ignore */ } } };
}

export function onQueueEnded(cb: () => void): Sub {
  const sub = TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => cb());
  return { remove: () => { try { (sub as any)?.remove?.(); } catch { /* ignore */ } } };
}

// ---- Lockscreen / notification remote-control subscriptions ----
//
// These mirror Event.RemotePlay / Event.RemotePause / Event.RemoteStop to a
// callback so PlayerContext can keep the React state (isPlaying, playingRef)
// in sync with the OS-controlled media UI. The same events are ALSO routed
// to the headless playback service (trackPlayerService.ts), which performs
// the actual TrackPlayer.play()/pause()/reset() side-effects.

export function onRemotePlay(cb: () => void): Sub {
  const sub = TrackPlayer.addEventListener(Event.RemotePlay, () => cb());
  return { remove: () => { try { (sub as any)?.remove?.(); } catch { /* ignore */ } } };
}

export function onRemotePause(cb: () => void): Sub {
  const sub = TrackPlayer.addEventListener(Event.RemotePause, () => cb());
  return { remove: () => { try { (sub as any)?.remove?.(); } catch { /* ignore */ } } };
}

export function onRemoteStop(cb: () => void): Sub {
  const sub = TrackPlayer.addEventListener(Event.RemoteStop, () => cb());
  return { remove: () => { try { (sub as any)?.remove?.(); } catch { /* ignore */ } } };
}

export function onPlaybackError(cb: (err: { code: string; message: string }) => void): Sub {
  const sub = TrackPlayer.addEventListener(Event.PlaybackError, (data: any) =>
    cb({ code: data?.code || 'unknown', message: data?.message || '' }),
  );
  return { remove: () => { try { (sub as any)?.remove?.(); } catch { /* ignore */ } } };
}

export function getStateEnum(): typeof State { return State; }
