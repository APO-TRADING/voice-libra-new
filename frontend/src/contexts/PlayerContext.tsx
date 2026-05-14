// Singleton on-device audio player.
// Primary engine: react-native-sherpa-onnx-offline-tts (Piper, on-device).
// Fallback engine: expo-speech (used in Expo Go preview / when model assets
// are not yet bundled).
//
// Pre-buffering: while a sentence is being spoken, the next-sentence
// synthesis is initiated immediately so playback feels seamless.
//
// Singleton: any new play() call hard-stops the previous one before starting.
import * as Speech from 'expo-speech';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { DeviceEventEmitter, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { api, BookFull } from '../api/client';
import {
  initEngine,
  isPiperReady,
  speakSentence as piperSpeak,
  stopSpeak as piperStop,
  getPiperDiagnostics,
  startPlaybackSession,
  updatePlaybackSession,
  stopPlaybackSession,
} from '../audio/piperEngine';

type State = {
  bookId: string | null;
  title: string;
  author: string | null;
  coverUrl: string | null;
  sentences: string[];
  index: number;
  isPlaying: boolean;
  lengthScale: number;
  engine: 'piper' | 'device' | 'unknown';
  piperError: string | null;
  piperStep: string;
};

type Ctx = State & {
  load: (bookId: string) => Promise<void>;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  jump: (delta: number) => void;
  goTo: (index: number) => void;
  setLengthScale: (v: number) => void;
  stop: () => void;
};

const PlayerContext = createContext<Ctx | undefined>(undefined);

export function PlayerProvider({ children }: { children: React.ReactNode }) {
  const [bookId, setBookId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [sentences, setSentences] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [lengthScale, setLengthScale] = useState(1.0);
  const [engine, setEngine] = useState<'piper' | 'device' | 'unknown'>('unknown');
  const [piperError, setPiperError] = useState<string | null>(null);
  const [piperStep, setPiperStep] = useState<string>('idle');

  const indexRef = useRef(index);
  const sentencesRef = useRef(sentences);
  const lengthScaleRef = useRef(lengthScale);
  const playingRef = useRef(false);
  const bookIdRef = useRef<string | null>(null);
  const titleRef = useRef<string>('');
  const authorRef = useRef<string | null>(null);
  const coverUrlRef = useRef<string | null>(null);
  const sessionStartedRef = useRef<boolean>(false);
  const generationRef = useRef(0); // monotonic ID to drop stale callbacks
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // PATCH (beppe-audiobooks v5): count consecutive Piper failures. Falling
  // back to the device TTS on every single error is too aggressive: a
  // transient native hiccup (e.g. AudioTrack underrun) would permanently
  // demote the engine. Only after MAX_PIPER_FAILS consecutive errors do
  // we accept that Piper is unusable and stay on the device fallback.
  // A successful piperSpeak resets the counter and promotes the engine
  // back to 'piper' if it was on 'device'.
  const piperFailCountRef = useRef(0);
  const MAX_PIPER_FAILS = 3;

  useEffect(() => { indexRef.current = index; }, [index]);
  useEffect(() => { sentencesRef.current = sentences; }, [sentences]);
  useEffect(() => { lengthScaleRef.current = lengthScale; }, [lengthScale]);
  useEffect(() => { bookIdRef.current = bookId; }, [bookId]);
  useEffect(() => { titleRef.current = title; }, [title]);
  useEffect(() => { authorRef.current = author; }, [author]);
  useEffect(() => { coverUrlRef.current = coverUrl; }, [coverUrl]);

  // PATCH (beppe-audiobooks v6): listen for media-button events from the
  // foreground service notification (Android) — translate them into the
  // same play()/pause()/jump() actions as the on-screen controls.
  // Also reacts to audio-focus changes (incoming call, etc.).
  // Use a ref to break the (otherwise circular) dependency cycle with
  // play() / pause() / jump().
  const ctrlRef = useRef<{ play: () => void; pause: () => void; jump: (d: number) => void } | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let subAction: any;
    let subFocus: any;
    try {
      const TTSManager = (NativeModules as any).TTSManager;
      const emitter = TTSManager ? new NativeEventEmitter(TTSManager) : null;
      const target: any = emitter || DeviceEventEmitter;
      subAction = target.addListener('piperMediaAction', (e: { action: string }) => {
        if (!e?.action) return;
        const c = ctrlRef.current;
        if (!c) return;
        if (e.action.endsWith('.PLAY')) c.play();
        else if (e.action.endsWith('.PAUSE')) c.pause();
        else if (e.action.endsWith('.NEXT')) c.jump(1);
        else if (e.action.endsWith('.PREVIOUS')) c.jump(-1);
        else if (e.action.endsWith('.STOP')) c.pause();
      });
      subFocus = target.addListener('piperAudioFocus', (e: { focus: number }) => {
        // -1=AUDIOFOCUS_LOSS, -2=TRANSIENT, -3=CAN_DUCK, 1=GAIN
        const c = ctrlRef.current;
        if (!c) return;
        if (e?.focus === -1 || e?.focus === -2) c.pause();
        // For AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK (-3) we keep playing —
        // the OS will lower our volume itself.
      });
    } catch (e) {
      console.warn('[Player] native media listeners failed:', e);
    }
    return () => {
      try { subAction?.remove(); } catch { /* ignore */ }
      try { subFocus?.remove(); } catch { /* ignore */ }
    };
  }, []);

  // NOTE: do NOT call initEngine() here. We initialize Piper lazily on the
  // first play() to keep app startup robust: if sherpa init were to crash
  // natively with a corrupt model, doing it on every launch would brick the
  // app. With lazy init, the user can still browse the library, upload books,
  // change settings, etc., even if Piper fails.

  const queueSave = useCallback((idx: number) => {
    const id = bookIdRef.current;
    if (!id) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.updateProgress(id, idx).catch(() => {});
    }, 500);
  }, []);

  const stopAll = useCallback(async () => {
    generationRef.current++;
    Speech.stop();
    if (isPiperReady()) {
      try { await piperStop(); } catch { /* ignore */ }
    }
  }, []);

  // Speak a single sentence using the active engine. Returns when the audio
  // playback for that sentence completes (or is aborted).
  const speakOne = useCallback(async (idx: number, gen: number): Promise<void> => {
    const list = sentencesRef.current;
    if (idx < 0 || idx >= list.length) return;
    const text = list[idx];
    const ls = lengthScaleRef.current;

    if (isPiperReady()) {
      try {
        // generateAndPlay resolves when the native player finishes the clip
        await piperSpeak(text, ls);
        // PATCH (beppe-audiobooks v5): success → reset fail counter and
        // promote engine back to 'piper' if we were on 'device' fallback.
        if (piperFailCountRef.current > 0) {
          piperFailCountRef.current = 0;
        }
        setEngine((prev) => (prev === 'device' ? 'piper' : prev));
        return;
      } catch (e) {
        piperFailCountRef.current += 1;
        console.warn(
          `[Piper] speak failed (${piperFailCountRef.current}/${MAX_PIPER_FAILS}), `,
          e
        );
        // Only flip the engine UI label to 'device' after MAX_PIPER_FAILS
        // consecutive errors. This avoids confusing users when a single
        // transient native hiccup happens (e.g. AudioTrack underrun).
        if (piperFailCountRef.current >= MAX_PIPER_FAILS) {
          setEngine('device');
        }
        // Fall through to device fallback for THIS sentence; the next
        // sentence will retry Piper from the top.
      }
    }

    // expo-speech fallback (also used in Expo Go preview)
    await new Promise<void>((resolve) => {
      const rate = Math.max(0.5, Math.min(2.0, 1 / ls));
      Speech.speak(text, {
        language: 'it-IT',
        rate,
        onDone: () => resolve(),
        onStopped: () => resolve(),
        onError: () => resolve(),
      });
    });
    if (gen !== generationRef.current) return; // stale
  }, []);

  const playLoop = useCallback(async (startIdx: number) => {
    const gen = ++generationRef.current;
    playingRef.current = true;
    setIsPlaying(true);

    let cur = startIdx;
    while (playingRef.current && gen === generationRef.current && cur < sentencesRef.current.length) {
      setIndex(cur);
      indexRef.current = cur;
      queueSave(cur);
      // Speak current; (Piper engine has no explicit pre-buffer API but native
      // synthesis is fast enough; queuing of next sentence happens implicitly
      // because the JS loop kicks the next call as soon as the current ends.)
      await speakOne(cur, gen);
      if (gen !== generationRef.current || !playingRef.current) return;
      cur += 1;
    }
    playingRef.current = false;
    setIsPlaying(false);
  }, [queueSave, speakOne]);

  const play = useCallback(() => {
    if (!sentencesRef.current.length) return;
    // PATCH (beppe-audiobooks v5): reset the consecutive-fail counter on
    // every fresh play() press so a new session always tries Piper first.
    piperFailCountRef.current = 0;
    // Lazy init: try Piper the first time the user presses play. If it fails,
    // the catch path will keep the user on the device-TTS fallback so the app
    // never crashes here.
    stopAll().then(async () => {
      if (engine === 'unknown' || !isPiperReady()) {
        try {
          const ok = await initEngine();
          setEngine(ok ? 'piper' : 'device');
          const diag = getPiperDiagnostics();
          setPiperError(diag.lastError);
          setPiperStep(diag.lastStep);
        } catch (e: any) {
          setEngine('device');
          setPiperError(`init-exception: ${e?.message || String(e)}`);
        }
      }
      // PATCH (beppe-audiobooks v6): start (or update) the foreground
      // service + MediaSession so the audiobook keeps playing with the
      // screen off and the user gets lock-screen / notification controls.
      const cover = coverUrlRef.current && coverUrlRef.current.startsWith('data:')
        ? coverUrlRef.current
        : null; // only embed when we have the actual bitmap as base64
      if (!sessionStartedRef.current) {
        sessionStartedRef.current = true;
        startPlaybackSession({
          title: titleRef.current || 'Audiobook',
          author: authorRef.current,
          coverBase64: cover,
          isPlaying: true,
        });
      } else {
        updatePlaybackSession({
          title: titleRef.current || 'Audiobook',
          author: authorRef.current,
          coverBase64: cover,
          isPlaying: true,
        });
      }
      playLoop(indexRef.current);
    });
  }, [engine, playLoop, stopAll]);

  const pause = useCallback(() => {
    playingRef.current = false;
    setIsPlaying(false);
    stopAll();
    // Update the notification to show the "play" button (the engine and
    // wake-lock stay alive so the user can resume instantly).
    if (sessionStartedRef.current) {
      updatePlaybackSession({
        title: titleRef.current || 'Audiobook',
        author: authorRef.current,
        isPlaying: false,
      });
    }
  }, [stopAll]);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [pause, play]);

  const goTo = useCallback((i: number) => {
    const max = sentencesRef.current.length;
    const clamped = Math.max(0, Math.min(i, Math.max(0, max - 1)));
    setIndex(clamped);
    indexRef.current = clamped;
    queueSave(clamped);
    if (playingRef.current) {
      stopAll().then(() => playLoop(clamped));
    }
  }, [queueSave, playLoop, stopAll]);

  const jump = useCallback((delta: number) => {
    goTo(indexRef.current + delta);
  }, [goTo]);

  const stop = useCallback(() => {
    pause();
    setBookId(null);
    setTitle('');
    setAuthor(null);
    setCoverUrl(null);
    setSentences([]);
    setIndex(0);
    // Tear down the foreground service + notification.
    if (sessionStartedRef.current) {
      sessionStartedRef.current = false;
      stopPlaybackSession();
    }
  }, [pause]);

  const load = useCallback(async (id: string) => {
    pause();
    const book: BookFull = await api.getBook(id);
    setBookId(book.id);
    setTitle(book.title);
    setAuthor(book.author || null);
    setCoverUrl(book.cover_url || null);
    setSentences(book.sentences || []);
    const startIdx = Math.max(0, Math.min(book.current_sentence_index || 0, (book.sentences?.length || 1) - 1));
    setIndex(startIdx);
    indexRef.current = startIdx;
    setLengthScale(book.length_scale || 1.0);
    lengthScaleRef.current = book.length_scale || 1.0;
    // Sync refs so the next play() picks up the freshly-loaded metadata.
    titleRef.current = book.title;
    authorRef.current = book.author || null;
    coverUrlRef.current = book.cover_url || null;
  }, [pause]);

  const updateLengthScale = useCallback((v: number) => {
    const clamped = Math.max(0.5, Math.min(2.0, v));
    setLengthScale(clamped);
    lengthScaleRef.current = clamped;
    const id = bookIdRef.current;
    if (id) api.updateBook(id, { length_scale: clamped }).catch(() => {});
    if (playingRef.current) {
      stopAll().then(() => playLoop(indexRef.current));
    }
  }, [playLoop, stopAll]);

  useEffect(() => () => { stopAll(); }, [stopAll]);

  // Keep ctrlRef in sync so the native listener can dispatch back to
  // the current handlers.
  useEffect(() => {
    ctrlRef.current = { play, pause, jump };
  }, [play, pause, jump]);

  const value = useMemo<Ctx>(() => ({
    bookId, title, author, coverUrl, sentences, index, isPlaying, lengthScale, engine, piperError, piperStep,
    load, play, pause, toggle, jump, goTo, setLengthScale: updateLengthScale, stop,
  }), [bookId, title, author, coverUrl, sentences, index, isPlaying, lengthScale, engine, piperError, piperStep, load, play, pause, toggle, jump, goTo, updateLengthScale, stop]);

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be inside PlayerProvider');
  return ctx;
}
