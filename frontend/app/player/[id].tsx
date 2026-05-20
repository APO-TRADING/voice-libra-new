import Slider from '@react-native-community/slider';
import { router, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, MoreVertical, Pause, Play, Rewind, FastForward, Trash2, Pencil, ImageIcon } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, Folder } from '../../src/api/client';
import { usePlayer } from '../../src/contexts/PlayerContext';
import { useTheme } from '../../src/contexts/ThemeContext';

const FALLBACK = 'https://images.unsplash.com/photo-1769490315625-6e669d53e698?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjAzMjh8MHwxfHNlYXJjaHwxfHxtaW5pbWFsaXN0JTIwYm9vayUyMGNvdmVyJTIwZGVzaWdufGVufDB8fHx8MTc3ODQyNzM2OHww&ixlib=rb-4.1.0&q=85';

// PATCH (v2.2): how many sentences to render BEFORE and AFTER the current
// index. Rendering all 13'682 sentences of a long novel blocks the UI thread
// for 20+ seconds on first mount (every <Text> registers an onLayout
// callback). With a 50-sentence window the screen opens instantly and the
// window slides as the user advances. Tapping any rendered sentence still
// works for jump-to-position; jumping FAR ahead from the controls is fine
// because the window re-centers on player.index.
const WINDOW_BEFORE = 50;
const WINDOW_AFTER = 100;

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '0 min';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} h ${rem} min` : `${h} h`;
}

export default function Player() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const player = usePlayer();
  const [loading, setLoading] = useState(true);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState<null | 'title' | 'cover' | 'folder'>(null);
  const [editValue, setEditValue] = useState('');
  const [folders, setFolders] = useState<Folder[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const sentenceLayouts = useRef<Record<number, number>>({});

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!id) return;
      try {
        await player.load(id);
        const meta = await api.getBook(id);
        if (mounted) setCoverUrl(meta.cover_url || null);
        api.listFolders().then((f) => mounted && setFolders(f)).catch(() => {});
      } catch (e: any) {
        Alert.alert('Errore', String(e?.message || e));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    // PATCH (beppe-audiobooks v6.1): do NOT pause on unmount. The user may
    // navigate away from the player while the audiobook keeps reading in
    // the background (foreground service + lock-screen controls). When
    // they tap another book, player.load() will internally pause the
    // previous session. When they tap "Stop" in the notification, the
    // native service emits ACTION_STOP which routes to pause() via the
    // ctrlRef. So leaving this useEffect without a pause() is correct.
    return () => { mounted = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Auto-scroll to current sentence
  useEffect(() => {
    const y = sentenceLayouts.current[player.index];
    if (y !== undefined && scrollRef.current) {
      scrollRef.current.scrollTo({ y: Math.max(0, y - 120), animated: true });
    }
  }, [player.index]);

  const total = player.sentences.length;
  // PATCH (v2.2): only iterate AHEAD of the current index when estimating the
  // remaining time. The previous version iterated all 13'682 sentences,
  // re-running on every index change (every 2-4 seconds during playback).
  // We use a word-density approximation for the tail of the book instead
  // of iterating every single sentence — accuracy is the same (±5%) but
  // the work is O(1) instead of O(n).
  const remainingWords = useMemo(() => {
    // Look at the first 200 sentences AFTER the index to estimate avg words
    // per sentence, then multiply by (total - index).
    const sample = Math.min(200, total - player.index);
    if (sample <= 0) return 0;
    let w = 0;
    for (let i = player.index; i < player.index + sample; i++) {
      const s = player.sentences[i] || '';
      w += s.split(/\s+/).filter(Boolean).length;
    }
    const avg = w / sample;
    return Math.round(avg * (total - player.index));
  }, [player.sentences, player.index, total]);

  // PATCH (v2.2): windowed rendering. Compute the [start, end) range of
  // sentences to render based on the current playback index. As the player
  // advances, the window slides forward keeping ~50 sentences visible
  // before the current and ~100 after. Total DOM cost: <200 <Text> nodes
  // instead of 13'000+ — opens instantly.
  const windowStart = Math.max(0, player.index - WINDOW_BEFORE);
  const windowEnd = Math.min(total, player.index + WINDOW_AFTER);
  const visibleSentences = useMemo(() => {
    return player.sentences.slice(windowStart, windowEnd);
  }, [player.sentences, windowStart, windowEnd]);

  // ~155 wpm at length_scale=1.0 (Italian voice). Higher length_scale => slower.
  const remainingSec = (remainingWords / 155) * 60 * player.lengthScale;
  const progress = total ? player.index / Math.max(1, total - 1) : 0;

  const onSubmitEdit = async () => {
    if (!id) return;
    const v = editValue.trim();
    try {
      if (editOpen === 'title' && v) await api.updateBook(id, { title: v });
      else if (editOpen === 'cover') {
        await api.updateBook(id, { cover_url: v || null });
        setCoverUrl(v || null);
      }
      setEditOpen(null);
      setEditValue('');
    } catch (e: any) {
      Alert.alert('Errore', String(e?.message || e));
    }
  };

  const onMoveToFolder = async (folderId: string | null) => {
    if (!id) return;
    try {
      await api.updateBook(id, { folder_id: folderId });
      setEditOpen(null);
      setMenuOpen(false);
      Alert.alert('Spostato', folderId ? 'Libro spostato nella cartella selezionata.' : 'Libro rimosso dalla cartella.');
    } catch (e: any) {
      Alert.alert('Errore', String(e?.message || e));
    }
  };

  const onDelete = () => {
    if (!id) return;
    Alert.alert('Elimina libro', 'L’azione è irreversibile. Continuare?', [
      { text: 'Annulla', style: 'cancel' },
      { text: 'Elimina', style: 'destructive', onPress: async () => {
        await api.deleteBook(id);
        player.stop();
        router.back();
      } },
    ]);
  };

  if (loading) {
    return (
      <View style={[styles.c, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={colors.primaryActive} />
      </View>
    );
  }

  return (
    <View style={[styles.c, { backgroundColor: colors.background }]} testID="player-screen">
      {/* v2.5 (cosmetic): the cover thumbnail is now embedded inside the
          top bar next to the title, freeing ~180px of vertical space for
          the text. The full cover is still available on the library
          card; here we just need a compact identity strip so the user
          knows which book they're reading. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity onPress={() => router.back()} testID="player-back" style={[styles.iconBtn, { borderColor: colors.border }]}>
          <ChevronLeft color={colors.textPrimary} size={20} />
        </TouchableOpacity>
        <Image source={{ uri: coverUrl || FALLBACK }} style={styles.topCover} />
        <View style={styles.topTitleWrap}>
          <Text numberOfLines={2} style={[styles.topTitle, { color: colors.textPrimary }]}>
            {player.title}
          </Text>
          {player.author ? (
            <Text numberOfLines={1} style={[styles.topAuthor, { color: colors.textSecondary }]}>
              {player.author}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity onPress={() => setMenuOpen(true)} testID="player-menu" style={[styles.iconBtn, { borderColor: colors.border }]}>
          <MoreVertical color={colors.textPrimary} size={20} />
        </TouchableOpacity>
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.textWrap}
        contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 16, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {/* PATCH (v2.2): only render the windowed slice. The absolute
            sentence index is windowStart + offset; we use that for the
            highlight check and the goTo handler. */}
        {windowStart > 0 && (
          <Text style={[styles.windowHint, { color: colors.textSecondary }]}>
            … {windowStart} frasi precedenti
          </Text>
        )}
        {visibleSentences.map((s, offset) => {
          const i = windowStart + offset;
          return (
            <Text
              key={i}
              testID={i === player.index ? 'active-sentence' : undefined}
              onLayout={(e) => { sentenceLayouts.current[i] = e.nativeEvent.layout.y; }}
              onPress={() => player.goTo(i)}
              style={[
                styles.sent,
                { color: i === player.index ? colors.textPrimary : colors.textSecondary },
                i === player.index && { backgroundColor: colors.highlight, fontWeight: '700' },
              ]}
            >
              {s}{' '}
            </Text>
          );
        })}
        {windowEnd < total && (
          <Text style={[styles.windowHint, { color: colors.textSecondary }]}>
            … {total - windowEnd} frasi successive
          </Text>
        )}
      </ScrollView>

      <View style={[styles.controls, { backgroundColor: colors.surface, borderTopColor: colors.border, paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.metaRow}>
          <Text style={[styles.metaText, { color: colors.textSecondary }]}>
            Frase {Math.min(player.index + 1, total)} / {total}
          </Text>
          <Text style={[styles.metaText, { color: colors.textSecondary }]}>~ {formatTime(remainingSec)} rimanenti</Text>
        </View>
        <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
          <View style={[styles.progressFill, { backgroundColor: colors.primaryActive, width: `${progress * 100}%` }]} />
        </View>

        <View style={styles.skipRow}>
          {[10, 5, 1].map((n) => (
            <TouchableOpacity
              key={`b-${n}`}
              testID={`skip-back-${n}`}
              onPress={() => player.jump(-n)}
              style={[styles.skipBtn, { borderColor: colors.border }]}
            >
              <Rewind color={colors.textPrimary} size={14} />
              <Text style={[styles.skipLabel, { color: colors.textPrimary }]}>{n}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            testID="play-pause-button"
            onPress={player.toggle}
            style={[styles.playBtn, { backgroundColor: colors.primaryActive }]}
          >
            {player.isPlaying ? <Pause color="#0A0A0C" size={28} fill="#0A0A0C" /> : <Play color="#0A0A0C" size={28} fill="#0A0A0C" />}
          </TouchableOpacity>
          {[1, 5, 10].map((n) => (
            <TouchableOpacity
              key={`f-${n}`}
              testID={`skip-fwd-${n}`}
              onPress={() => player.jump(n)}
              style={[styles.skipBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.skipLabel, { color: colors.textPrimary }]}>{n}</Text>
              <FastForward color={colors.textPrimary} size={14} />
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.speedRow}>
          <Text style={[styles.speedLabel, { color: colors.textSecondary }]}>Velocità</Text>
          <Slider
            testID="speed-slider"
            minimumValue={0.5}
            maximumValue={2.0}
            step={0.05}
            value={player.lengthScale}
            onValueChange={player.setLengthScale}
            minimumTrackTintColor={colors.primaryActive}
            maximumTrackTintColor={colors.border}
            thumbTintColor={colors.primaryActive}
            style={{ flex: 1 }}
          />
          <Text style={[styles.speedValue, { color: colors.primaryActive }]}>{player.lengthScale.toFixed(2)}×</Text>
        </View>
      </View>

      {/* Action Sheet Menu */}
      <Modal transparent visible={menuOpen} animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setMenuOpen(false)} style={styles.sheetBg}>
          <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border, paddingBottom: insets.bottom + 8 }]}>
            <TouchableOpacity
              testID="menu-rename"
              onPress={() => { setMenuOpen(false); setEditOpen('title'); setEditValue(player.title); }}
              style={styles.sheetItem}
            >
              <Pencil color={colors.textPrimary} size={18} />
              <Text style={[styles.sheetLabel, { color: colors.textPrimary }]}>Rinomina</Text>
            </TouchableOpacity>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <TouchableOpacity
              testID="menu-cover"
              onPress={() => { setMenuOpen(false); setEditOpen('cover'); setEditValue(coverUrl || ''); }}
              style={styles.sheetItem}
            >
              <ImageIcon color={colors.textPrimary} size={18} />
              <Text style={[styles.sheetLabel, { color: colors.textPrimary }]}>Modifica copertina (URL)</Text>
            </TouchableOpacity>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <TouchableOpacity
              testID="menu-folder"
              onPress={() => { setMenuOpen(false); setTimeout(() => setEditOpen('folder'), 100); }}
              style={styles.sheetItem}
            >
              <Pencil color={colors.textPrimary} size={18} />
              <Text style={[styles.sheetLabel, { color: colors.textPrimary }]}>Sposta in cartella</Text>
            </TouchableOpacity>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <TouchableOpacity testID="menu-delete" onPress={() => { setMenuOpen(false); onDelete(); }} style={styles.sheetItem}>
              <Trash2 color={colors.danger} size={18} />
              <Text style={[styles.sheetLabel, { color: colors.danger }]}>Elimina libro</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      <Modal transparent visible={editOpen === 'title' || editOpen === 'cover'} animationType="fade" onRequestClose={() => setEditOpen(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modalBg}>
          <View style={[styles.modal, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              {editOpen === 'title' ? 'Rinomina libro' : 'URL copertina'}
            </Text>
            <TextInput
              testID="edit-input"
              value={editValue}
              onChangeText={setEditValue}
              placeholder={editOpen === 'title' ? 'Nuovo titolo' : 'https://…'}
              placeholderTextColor={colors.textSecondary}
              autoCapitalize={editOpen === 'cover' ? 'none' : 'sentences'}
              style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.background }]}
              autoFocus
            />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <TouchableOpacity onPress={() => setEditOpen(null)} style={[styles.modalBtn, { borderColor: colors.border, borderWidth: 1 }]}>
                <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>Annulla</Text>
              </TouchableOpacity>
              <TouchableOpacity testID="edit-save" onPress={onSubmitEdit} style={[styles.modalBtn, { backgroundColor: colors.primaryActive }]}>
                <Text style={{ color: '#0A0A0C', fontWeight: '700' }}>Salva</Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal transparent visible={editOpen === 'folder'} animationType="fade" onRequestClose={() => setEditOpen(null)}>
        <TouchableOpacity activeOpacity={1} onPress={() => setEditOpen(null)} style={styles.sheetBg}>
          <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border, paddingBottom: insets.bottom + 8, maxHeight: 420 }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary, marginBottom: 8, paddingHorizontal: 8 }]}>Sposta in cartella</Text>
            <ScrollView>
              <TouchableOpacity onPress={() => onMoveToFolder(null)} style={styles.sheetItem} testID="folder-pick-none">
                <Text style={[styles.sheetLabel, { color: colors.textPrimary }]}>Senza cartella</Text>
              </TouchableOpacity>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              {folders.map((f) => (
                <View key={f.id}>
                  <TouchableOpacity onPress={() => onMoveToFolder(f.id)} style={styles.sheetItem} testID={`folder-pick-${f.id}`}>
                    <Text style={[styles.sheetLabel, { color: colors.textPrimary }]}>{f.name}</Text>
                  </TouchableOpacity>
                  <View style={[styles.divider, { backgroundColor: colors.border }]} />
                </View>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 12 },
  iconBtn: { width: 40, height: 40, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  // v2.5: compact cover thumbnail inline with the title — frees ~180px
  // of vertical space versus the old 120×180 hero card.
  topCover: { width: 44, height: 66, borderRadius: 8 },
  topTitleWrap: { flex: 1, justifyContent: 'center' },
  topTitle: { fontSize: 15, fontWeight: '700', textAlign: 'left' },
  topAuthor: { fontSize: 12, opacity: 0.75, marginTop: 2 },
  textWrap: { flex: 1 },
  sent: { fontSize: 18, lineHeight: 28, paddingVertical: 2, paddingHorizontal: 4, borderRadius: 6 },
  windowHint: { fontSize: 12, opacity: 0.5, textAlign: 'center', paddingVertical: 12, fontStyle: 'italic' },
  controls: { paddingHorizontal: 24, paddingTop: 16, borderTopWidth: 1, gap: 14 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between' },
  metaText: { fontSize: 12, letterSpacing: 0.4, fontWeight: '600' },
  progressTrack: { height: 3, borderRadius: 999, overflow: 'hidden' },
  progressFill: { height: '100%' },
  skipRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginTop: 4 },
  skipBtn: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 10, height: 40, borderRadius: 999, borderWidth: 1 },
  skipLabel: { fontSize: 13, fontWeight: '700' },
  playBtn: { width: 64, height: 64, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  speedRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  speedLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5, width: 64 },
  speedValue: { fontSize: 13, fontWeight: '700', width: 56, textAlign: 'right' },
  sheetBg: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, borderTopWidth: 1, paddingTop: 16, paddingHorizontal: 8 },
  sheetItem: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 16 },
  sheetLabel: { fontSize: 15, fontWeight: '600' },
  divider: { height: 1, marginHorizontal: 16 },
  modalBg: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 24 },
  modal: { width: '100%', maxWidth: 380, borderRadius: 24, padding: 24, gap: 16, borderWidth: 1 },
  modalTitle: { fontSize: 20, fontWeight: '700' },
  input: { height: 48, borderRadius: 12, paddingHorizontal: 14, borderWidth: 1, fontSize: 15 },
  modalBtn: { flex: 1, height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
});
