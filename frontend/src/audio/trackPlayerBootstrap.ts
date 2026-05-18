// trackPlayerBootstrap.ts
//
// Side-effect module imported at the top of app/_layout.tsx to register
// the react-native-track-player headless playback service BEFORE any
// React component mounts. The headless task fires when the OS routes a
// media-button event (play/pause/stop from lockscreen or notification)
// to our app while the React tree is not visible.
//
// We gate the registration on Platform.OS so the import is a no-op in
// the Metro web bundle (TrackPlayer is native-only).
//
// PATCH (beppe-audiobooks v8): registerPlaybackService is deferred to
// the next event-loop tick via setTimeout(0). Calling it synchronously
// during module-load on the very first JS frame can race with the
// native MainApplication.onCreate() pass under the New Architecture's
// bridgeless interop layer, causing a native crash before the JS bundle
// even starts evaluating. Deferring by one tick lets the native bridge
// finish hooking the playback service before we touch it.
import { Platform } from 'react-native';

if (Platform.OS === 'android' || Platform.OS === 'ios') {
  // setTimeout(0) is safe in Hermes/JSC and runs on the next macrotask
  // tick, AFTER all top-level imports of _layout.tsx have finished.
  setTimeout(() => {
    try {
      // Require lazily so the require chain doesn't try to load
      // react-native-track-player on web platforms.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const TrackPlayer = require('react-native-track-player').default as typeof import('react-native-track-player').default;
      if (TrackPlayer && typeof TrackPlayer.registerPlaybackService === 'function') {
        TrackPlayer.registerPlaybackService(
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          () => require('./trackPlayerService').default,
        );
      }
    } catch (e) {
      // Should never happen on native; logged for diagnostics.
      // eslint-disable-next-line no-console
      console.warn('[trackPlayerBootstrap] registerPlaybackService failed:', e);
    }
  }, 0);
}

export {};
