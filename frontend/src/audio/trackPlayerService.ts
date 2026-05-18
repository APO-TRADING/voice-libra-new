// trackPlayerService.ts — the headless playback service registered via
// TrackPlayer.registerPlaybackService(). Runs in its own JS VM context
// when the OS delivers media-button events while our React tree is not
// mounted.
//
// Per spec, we only expose Play / Pause / Stop — no SkipForward / SkipBackward
// from the lockscreen. The main app subscribes to the resulting state
// changes to keep its in-app player UI in sync (see PlayerContext.tsx).
import TrackPlayer, { Event } from 'react-native-track-player';

async function service(): Promise<void> {
  TrackPlayer.addEventListener(Event.RemotePlay, () => {
    TrackPlayer.play();
  });
  TrackPlayer.addEventListener(Event.RemotePause, () => {
    TrackPlayer.pause();
  });
  TrackPlayer.addEventListener(Event.RemoteStop, async () => {
    // Stop discards the whole queue — the audiobook reading session
    // is gone until the user starts again.
    try { await TrackPlayer.reset(); } catch { /* ignore */ }
  });
  // Some OS implementations send a duck event when another app needs
  // priority. Pause politely.
  TrackPlayer.addEventListener(Event.RemoteDuck, async (e: any) => {
    if (e?.paused) {
      try { await TrackPlayer.pause(); } catch { /* ignore */ }
    } else if (e?.permanent) {
      try { await TrackPlayer.reset(); } catch { /* ignore */ }
    }
  });
}

export default service;
