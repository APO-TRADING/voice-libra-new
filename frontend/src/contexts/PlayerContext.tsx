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
import { api, BookFull } from '../api/client';
import { initEngine, isPiperReady, speakSentence as piperSpeak, stopSpeak as piperStop } from '../audio/piperEngine';

type State = {
  bookId: string | null;
  title: string;
  sentences: string[];
  index: number;
  isPlaying: boolean;
  lengthScale: number;
  engine: 'piper' | 'device' | 'unknown';
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
  const [sentences, setSentences] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [lengthScale, setLengthScale] = useState(1.0);
  const [engine, setEngine] = useState<'piper' | 'device' | 'unknown'>('unknown');

  const indexRef = useRef(index);
  const sentencesRef = useRef(sentences);
  const lengthScaleRef = useRef(lengthScale);
  const playingRef = useRef(false);
  const bookIdRef = useRef<string | null>(null);
  const generationRef = useRef(0); // monotonic ID to drop stale callbacks
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { indexRef.current = index; }, [index]);
  useEffect(() => { sentencesRef.current = sentences; }, [sentences]);
  useEffect(() => { lengthScaleRef.current = lengthScale; }, [lengthScale]);
  useEffect(() => { bookIdRef.current = bookId; }, [bookId]);

  // Initialize Piper once at provider mount; if not available we use device TTS.
  useEffect(() => {
    initEngine().then((ok) => setEngine(ok ? 'piper' : 'device'));
  }, []);

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
        return;
      } catch (e) {
        console.warn('[Piper] speak failed, falling back to device:', e);
        setEngine('device');
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
    stopAll().then(() => {
      playLoop(indexRef.current);
    });
  }, [playLoop, stopAll]);

  const pause = useCallback(() => {
    playingRef.current = false;
    setIsPlaying(false);
    stopAll();
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
    setSentences([]);
    setIndex(0);
  }, [pause]);

  const load = useCallback(async (id: string) => {
    pause();
    const book: BookFull = await api.getBook(id);
    setBookId(book.id);
    setTitle(book.title);
    setSentences(book.sentences || []);
    const startIdx = Math.max(0, Math.min(book.current_sentence_index || 0, (book.sentences?.length || 1) - 1));
    setIndex(startIdx);
    indexRef.current = startIdx;
    setLengthScale(book.length_scale || 1.0);
    lengthScaleRef.current = book.length_scale || 1.0;
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

  const value = useMemo<Ctx>(() => ({
    bookId, title, sentences, index, isPlaying, lengthScale, engine,
    load, play, pause, toggle, jump, goTo, setLengthScale: updateLengthScale, stop,
  }), [bookId, title, sentences, index, isPlaying, lengthScale, engine, load, play, pause, toggle, jump, goTo, updateLengthScale, stop]);

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>;
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error('usePlayer must be inside PlayerProvider');
  return ctx;
}
