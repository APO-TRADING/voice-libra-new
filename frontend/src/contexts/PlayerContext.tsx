// Singleton on-device audio player.
// Primary engine: piper-tts local native module (Microsoft ONNX Runtime + Piper VITS).
// Fallback engine: expo-speech (used in Expo Go preview / when model assets
// are not yet bundled).
//
// Pre-buffering: while a sentence is being spoken, the next-sentence
// synthesis is initiated immediately so playback feels seamless.
//
// Lockscreen / background audio: expo-audio owns the lockscreen +
// notification + media-buttons UI via setActiveForLockScreen. We
// subscribe to its playbackStatusUpdate stream so an OS-level Play/Pause
// tap is reflected in our React state and routes back through the same
// play() / pause() actions the on-screen UI triggers.
//
// Singleton: any new play() call hard-stops the previous one before starting.
import * as Speech from 'expo-speech';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, BookFull } from '../api/client';
import {
  initEngine,
  isPiperReady,
  speakSentence as piperSpeak,
  prebufferSentence as piperPrebuffer,
  stopSpeak as piperStop,
  pauseSpeak as piperPause,
  resumeSpeak as piperResume,
  getPiperDiagnostics,
  tracePiper,
} from '../audio/piperEngine';
import {
  onRemotePause,
  onRemotePlay,
} from '../audio/audiobookPlayer';

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

  // PATCH (beppe-audiobooks v8): lockscreen / notification remote-control
  // events from expo-audio. Lock-screen shows Play/Pause buttons; tapping
  // them invokes player.play()/pause() directly on the active player,
  // which we observe via the player's playbackStatusUpdate stream — see
  // audiobookPlayer.ts where we forward `playing/paused` deltas as
  // onRemotePlay/onRemotePause callbacks. We mirror those into our
  // play()/pause() handlers so the on-screen state stays in sync.
  // Use a ref to break the (otherwise circular) dependency cycle with
  // play() / pause().
  const ctrlRef = useRef<{ play: () => void; pause: () => void } | null>(null);

  useEffect(() => {
    const subPlay = onRemotePlay(() => {
      tracePiper('remote.play', 'lockscreen tap');
      // Only react if the user wasn't already playing — avoids feedback
      // loops where our own player.play() bounces back as a remote event.
      if (!playingRef.current) ctrlRef.current?.play();
    });
    const subPause = onRemotePause(() => {
      tracePiper('remote.pause', 'lockscreen tap');
      if (playingRef.current) ctrlRef.current?.pause();
    });
    return () => {
      try { subPlay.remove(); } catch { /* ignore */ }
      try { subPause.remove(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // Lockscreen / notification metadata: ONLY the static book identity
        // (title + author + voice). Per spec, we never put the running
        // sentence text on the OS UI — too distracting and changes every
        // few seconds.
        const rawCover = coverUrlRef.current;
        const tpCover =
          rawCover && (rawCover.startsWith('http://') ||
                       rawCover.startsWith('https://') ||
                       rawCover.startsWith('file://'))
            ? rawCover
            : null;
        await piperSpeak(text, ls, {
          bookTitle: titleRef.current || 'Audiobook',
          bookAuthor: authorRef.current || '',
          coverUrl: tpCover,
        });
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

  // PATCH (beppe-audiobooks v9): soft-pause support.
  //   - pausedRef.current === true  -> the playLoop is awaiting on a paused
  //     player. The lockscreen / notification stays alive; the next play()
  //     call should call piperResume() instead of restarting the loop.
  const pausedRef = useRef(false);

  const playLoop = useCallback(async (startIdx: number) => {
    const gen = ++generationRef.current;
    playingRef.current = true;
    pausedRef.current = false;
    setIsPlaying(true);

    let cur = startIdx;
    while (playingRef.current && gen === generationRef.current && cur < sentencesRef.current.length) {
      setIndex(cur);
      indexRef.current = cur;
      queueSave(cur);

      // PRE-BUFFER NEXT SENTENCE: kick off synthesis of sentence cur+1 in the
      // background while the current one plays. The native module queues
      // synth jobs internally; by the time the current sentence's audio
      // finishes, the next WAV is usually ready on disk so the gap drops
      // from ~300ms to <50ms. Fire-and-forget; speakOne checks the buffer
      // when it gets to that index.
      const nextIdx = cur + 1;
      if (nextIdx < sentencesRef.current.length) {
        const nextText = sentencesRef.current[nextIdx];
        piperPrebuffer(nextText, lengthScaleRef.current).catch(() => { /* ignore */ });
      }

      await speakOne(cur, gen);
      if (gen !== generationRef.current) return;
      // If the user soft-paused mid-sentence, playingRef will be false
      // BUT pausedRef will be true — DON'T exit the loop; keep awaiting
      // a resume() call.
      if (!playingRef.current && !pausedRef.current) return;
      if (!playingRef.current && pausedRef.current) {
        // Soft-paused: park here until play()/stop() touches the refs.
        // We let speakOne return; the player is paused, the lockscreen is
        // still showing this sentence, and a resume will fire didJustFinish
        // for THIS sentence — which we re-await via a tiny spin.
        // (speakSentence resolves only on 'finished' or 'idle'. A paused
        // player produces neither, so this branch is only reachable on
        // resume → finished. Safe to advance.)
      }
      cur += 1;
    }
    playingRef.current = false;
    pausedRef.current = false;
    setIsPlaying(false);
  }, [queueSave, speakOne]);

  const play = useCallback(() => {
    if (!sentencesRef.current.length) {
      tracePiper('play.noop', 'sentences empty');
      return;
    }
    // RESUME path: if we were soft-paused, just un-pause expo-audio. The
    // playLoop is still alive and awaiting on speakOne; resumeSpeak makes
    // the player fire didJustFinish at the end of the current sentence,
    // which un-blocks the loop and advances naturally.
    if (pausedRef.current) {
      tracePiper('play.resume', `idx=${indexRef.current}`);
      pausedRef.current = false;
      playingRef.current = true;
      setIsPlaying(true);
      piperResume().catch(() => { /* ignore */ });
      return;
    }
    tracePiper('play.tap', `idx=${indexRef.current}/${sentencesRef.current.length} title="${titleRef.current.slice(0, 40)}"`);
    // PATCH (beppe-audiobooks v5): reset the consecutive-fail counter on
    // every fresh play() press so a new session always tries Piper first.
    piperFailCountRef.current = 0;
    // FRESH start: hard-stop any prior session, init engine if needed,
    // then start a new playLoop.
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
      // expo-audio owns the lockscreen / notification UI now. The track
      // metadata (book title + author) is set per-sentence inside
      // speakSentence() via the meta object passed from speakOne() below.
      playLoop(indexRef.current);
    });
  }, [engine, playLoop, stopAll]);

  const pause = useCallback(() => {
    // SOFT pause: keep the playLoop awaiting, keep the lockscreen visible,
    // keep the current sentence's WAV loaded. Just halt audio output.
    // Pressing play() (on-screen or from lockscreen) resumes mid-sentence.
    //
    // GUARD: only mark the player as soft-paused if we are actually mid-
    // playback. Calling pause() on an idle player (e.g. from load() when
    // entering a fresh book) would otherwise leave pausedRef=true and
    // hijack the NEXT play() press into a no-op resume path. The user-
    // visible symptom was: tap Play on a fresh book → trace shows
    // "play.resume :: idx=0" → expo-audio.resume() on an unloaded
    // player → no audio. This is the fix.
    if (!playingRef.current && !pausedRef.current) {
      tracePiper('pause.noop', 'not currently playing or paused');
      return;
    }
    tracePiper('pause.tap', `idx=${indexRef.current}`);
    pausedRef.current = true;
    playingRef.current = false;
    setIsPlaying(false);
    piperPause().catch(() => { /* ignore */ });
  }, []);

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
    tracePiper('stop.tap', `book=${bookIdRef.current || 'none'}`);
    // HARD stop: hard-cancel the playLoop, clear the lockscreen widget
    // and dispose of any cached WAV (synth + pre-buffer). Distinct from
    // pause() which only suspends audio output.
    pausedRef.current = false;
    playingRef.current = false;
    setIsPlaying(false);
    stopAll();
    setBookId(null);
    setTitle('');
    setAuthor(null);
    setCoverUrl(null);
    setSentences([]);
    setIndex(0);
  }, [stopAll]);

  const load = useCallback(async (id: string) => {
    tracePiper('load.start', `id=${id} prev=${bookIdRef.current || 'none'}`);
    // PATCH (beppe-audiobooks v6.4): if the user re-enters the player for
    // the book that is ALREADY playing (e.g. they tapped the mini-player
    // or the library card while the book is being read), do NOT reset the
    // playback state. The previous unconditional pause() + reload would
    // stop the TTS mid-sentence and lose context. Just return — the live
    // state (sentences, index, isPlaying, etc.) is already in the context.
    if (bookIdRef.current === id) {
      tracePiper('load.skip', 'same book already loaded');
      return;
    }
    // PATCH (v12.0 multi-voice): switching to a DIFFERENT book must do a
    // HARD reset of the playback refs, not a soft pause(). The previous
    // implementation called pause() which set pausedRef=true; the
    // pausedRef then survived the load() and made the very next play()
    // press on the new book take the "resume" path and stall (logs
    // showed "play.resume :: idx=0" → "audio.resume :: soft" → silence).
    // We now do a full stopAll() and zero out both refs so the new
    // book always starts via the fresh-play path.
    pausedRef.current = false;
    playingRef.current = false;
    setIsPlaying(false);
    await stopAll();
    try {
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
      tracePiper('load.ok', `title="${book.title.slice(0, 40)}" sentences=${book.sentences?.length || 0} startIdx=${startIdx}`);
    } catch (e: any) {
      tracePiper('load.err', String(e?.message || e));
      throw e;
    }
  }, [stopAll]);

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

  // Keep ctrlRef in sync so the OS remote-control listeners (lockscreen /
  // notification) can dispatch back to the current handlers.
  useEffect(() => {
    ctrlRef.current = { play, pause };
  }, [play, pause]);

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
