// Reusable book grid/list with search + sort controls + per-row long-press menu.
import { router } from 'expo-router';
import {
  ArrowDownAZ,
  ArrowDownUp,
  ArrowUp,
  ArrowDown,
  Check,
  Clock,
  Edit3,
  Grid3x3,
  List as ListIcon,
  MoreVertical,
  Pause,
  Play,
  Search,
  Trash2,
  UserCircle,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { api, BookSummary, Folder, SortMode } from '../api/client';
import { usePlayer } from '../contexts/PlayerContext';
import { useTheme } from '../contexts/ThemeContext';
import { useT } from '../i18n';
import BookEditModal from './BookEditModal';

const FALLBACK_COVERS = [
  'https://images.unsplash.com/photo-1769490315625-6e669d53e698?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjAzMjh8MHwxfHNlYXJjaHwxfHxtaW5pbWFsaXN0JTIwYm9vayUyMGNvdmVyJTIwZGVzaWdufGVufDB8fHx8MTc3ODQyNzM2OHww&ixlib=rb-4.1.0&q=85',
  'https://images.unsplash.com/photo-1768866898428-82a44cddd0e9?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjAzMjh8MHwxfHNlYXJjaHwyfHxtaW5pbWFsaXN0JTIwYm9vayUyMGNvdmVyJTIwZGVzaWdufGVufDB8fHx8MTc3ODQyNzM2OHww&ixlib=rb-4.1.0&q=85',
];

function coverFor(book: BookSummary): string {
  if (book.cover_url) return book.cover_url;
  let h = 0;
  for (let i = 0; i < book.id.length; i++) h = (h * 31 + book.id.charCodeAt(i)) >>> 0;
  return FALLBACK_COVERS[h % FALLBACK_COVERS.length];
}

function progressPct(b: BookSummary): number {
  if (!b.sentence_count) return 0;
  return Math.min(100, Math.round((b.current_sentence_index / b.sentence_count) * 100));
}

type Props = {
  books: BookSummary[];
  folders: Folder[];
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  reload: () => void;
  emptyMessage?: string;
};

export default function BookList({
  books,
  folders,
  loading,
  refreshing,
  onRefresh,
  reload,
  emptyMessage,
}: Props) {
  const { colors, viewMode, setViewMode } = useTheme();
  const t = useT();
  // PATCH (beppe-audiobooks v6.4): subscribe to the live player state so
  // the row representing the currently-playing book can show a "live"
  // badge instead of the regular Play button.
  const player = usePlayer();
  const activeBookId = player.bookId;
  const activeIsPlaying = player.isPlaying;
  const [sortMode, setSortModeLocal] = useState<SortMode>('recent');
  const [manualMode, setManualMode] = useState(false);
  const [actionFor, setActionFor] = useState<BookSummary | null>(null);
  const [editFor, setEditFor] = useState<BookSummary | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api.getSortMode().then((m) => {
      setSortModeLocal(m);
      setManualMode(m === 'manual');
    });
  }, []);

  // ─── client-side filter + sort ─────────────────────────
  const filteredBooks = useMemo(() => {
    if (!query.trim()) return books;
    const q = query.trim().toLowerCase();
    return books.filter((b) => {
      const haystack = `${b.title} ${b.author || ''}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [books, query]);

  const sortedBooks = useMemo(() => {
    const arr = [...filteredBooks];
    switch (sortMode) {
      case 'manual':
        arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        break;
      case 'title':
        arr.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
        break;
      case 'author':
        arr.sort((a, b) => {
          const aa = (a.author || '').trim();
          const bb = (b.author || '').trim();
          if (!aa && bb) return 1;
          if (aa && !bb) return -1;
          const c = aa.localeCompare(bb, undefined, { sensitivity: 'base' });
          if (c !== 0) return c;
          return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
        });
        break;
      case 'recent':
      default:
        arr.sort((a, b) => (b.updated_at < a.updated_at ? -1 : 1));
    }
    return arr;
  }, [filteredBooks, sortMode]);

  const persistMode = useCallback(async (m: SortMode) => {
    setSortModeLocal(m);
    setManualMode(m === 'manual');
    await api.setSortMode(m);
  }, []);

  const moveBook = useCallback(
    async (id: string, direction: -1 | 1) => {
      const list = [...sortedBooks];
      const i = list.findIndex((b) => b.id === id);
      if (i < 0) return;
      const j = i + direction;
      if (j < 0 || j >= list.length) return;
      const [moved] = list.splice(i, 1);
      list.splice(j, 0, moved);
      await api.reorderBooks(list.map((b) => b.id));
      reload();
    },
    [sortedBooks, reload],
  );

  const onLongPress = useCallback((b: BookSummary) => {
    setActionFor(b);
  }, []);

  const closeAction = () => setActionFor(null);

  const handleDelete = (b: BookSummary) => {
    Alert.alert(
      t('library.book.delete.confirmTitle'),
      t('library.book.delete.confirmBody', { title: b.title }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await api.deleteBook(b.id);
              reload();
            } catch (e) {
              console.warn(e);
            }
          },
        },
      ],
    );
  };

  // ─── Header (search + sort + view-mode) ────────────────
  const Header = (
    <View style={styles.toolbar}>
      <View style={[styles.searchBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Search color={colors.textSecondary} size={16} />
        <TextInput
          testID="library-search-input"
          value={query}
          onChangeText={setQuery}
          placeholder={t('library.search.placeholder')}
          placeholderTextColor={colors.textSecondary}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          style={[styles.searchInput, { color: colors.textPrimary }]}
        />
        {query.length > 0 ? (
          <TouchableOpacity onPress={() => setQuery('')} hitSlop={8}>
            <X color={colors.textSecondary} size={16} />
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.controlsRow}>
        <View style={styles.sortChips}>
          <SortChip
            icon={<Clock color={sortMode === 'recent' ? colors.primaryActive : colors.textSecondary} size={14} />}
            label={t('library.sort.recent')}
            active={sortMode === 'recent'}
            onPress={() => persistMode('recent')}
            colors={colors}
          />
          <SortChip
            icon={<ArrowDownAZ color={sortMode === 'title' ? colors.primaryActive : colors.textSecondary} size={14} />}
            label={t('library.sort.title')}
            active={sortMode === 'title'}
            onPress={() => persistMode('title')}
            colors={colors}
          />
          <SortChip
            icon={<UserCircle color={sortMode === 'author' ? colors.primaryActive : colors.textSecondary} size={14} />}
            label={t('library.sort.author')}
            active={sortMode === 'author'}
            onPress={() => persistMode('author')}
            colors={colors}
          />
          <SortChip
            icon={<ArrowDownUp color={sortMode === 'manual' ? colors.primaryActive : colors.textSecondary} size={14} />}
            label={t('library.sort.manual')}
            active={sortMode === 'manual'}
            onPress={() => persistMode('manual')}
            colors={colors}
          />
        </View>
        <TouchableOpacity
          testID="library-view-toggle"
          onPress={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
          style={[styles.iconBtn, { borderColor: colors.border }]}
        >
          {viewMode === 'grid' ? (
            <ListIcon color={colors.textSecondary} size={18} />
          ) : (
            <Grid3x3 color={colors.textSecondary} size={18} />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primaryActive} />
      </View>
    );
  }

  const emptyText =
    query.trim().length > 0
      ? t('library.empty.search')
      : emptyMessage || t('library.empty.generic');

  if (!sortedBooks.length) {
    return (
      <View style={{ flex: 1 }}>
        {Header}
        <View style={styles.center}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{emptyText}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {Header}
      {viewMode === 'grid' ? (
        <FlatList
          key="grid"
          data={sortedBooks}
          numColumns={2}
          keyExtractor={(b) => b.id}
          columnWrapperStyle={{ gap: 16, paddingHorizontal: 24 }}
          // PATCH (beppe-audiobooks v6.4): extra bottom padding so the
          // last row isn't covered by the floating MiniPlayer pill.
          contentContainerStyle={{ gap: 24, paddingVertical: 16, paddingBottom: activeBookId ? 168 : 96 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primaryActive} />
          }
          renderItem={({ item, index }) => {
            const isActive = activeBookId === item.id;
            return (
            <View style={styles.gridCard}>
              <TouchableOpacity
                testID={`book-card-${item.id}`}
                onPress={() => router.push(`/player/${item.id}`)}
                onLongPress={() => onLongPress(item)}
                activeOpacity={0.85}
                style={{ gap: 8 }}
              >
                <View>
                  <Image
                    source={{ uri: coverFor(item) }}
                    style={[
                      styles.cover,
                      {
                        backgroundColor: colors.surface,
                        borderWidth: isActive ? 2 : 0,
                        borderColor: isActive ? colors.primaryActive : 'transparent',
                      },
                    ]}
                  />
                  {isActive ? (
                    <View style={[styles.nowBadge, { backgroundColor: colors.primaryActive }]}>
                      {activeIsPlaying ? (
                        <Pause color="#0A0A0C" size={11} fill="#0A0A0C" />
                      ) : (
                        <Play color="#0A0A0C" size={11} fill="#0A0A0C" />
                      )}
                      <Text style={[styles.nowBadgeLabel, { color: '#0A0A0C' }]} numberOfLines={1}>
                        {activeIsPlaying ? t('library.nowPlaying') : t('library.paused')}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
                  <View
                    style={[
                      styles.progressFill,
                      { backgroundColor: colors.primaryActive, width: `${progressPct(item)}%` },
                    ]}
                  />
                </View>
                <Text numberOfLines={2} style={[styles.gridTitle, { color: colors.textPrimary }]}>
                  {item.title}
                </Text>
                {item.author ? (
                  <Text numberOfLines={1} style={[styles.gridAuthor, { color: colors.textSecondary }]}>
                    {item.author}
                  </Text>
                ) : null}
                <Text style={[styles.gridMeta, { color: colors.textSecondary }]}>
                  {t('library.book.progress', { percent: progressPct(item), count: item.sentence_count })}
                </Text>
              </TouchableOpacity>

              {manualMode && !query.trim() ? (
                <View style={styles.gridReorder}>
                  <TouchableOpacity
                    disabled={index === 0}
                    onPress={() => moveBook(item.id, -1)}
                    style={[
                      styles.reorderBtn,
                      { borderColor: colors.border, opacity: index === 0 ? 0.35 : 1 },
                    ]}
                  >
                    <ArrowUp color={colors.textPrimary} size={14} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    disabled={index === sortedBooks.length - 1}
                    onPress={() => moveBook(item.id, 1)}
                    style={[
                      styles.reorderBtn,
                      {
                        borderColor: colors.border,
                        opacity: index === sortedBooks.length - 1 ? 0.35 : 1,
                      },
                    ]}
                  >
                    <ArrowDown color={colors.textPrimary} size={14} />
                  </TouchableOpacity>
                </View>
              ) : null}
            </View>
            );
          }}
        />
      ) : (
        <FlatList
          key="list"
          data={sortedBooks}
          keyExtractor={(b) => b.id}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: activeBookId ? 168 : 96, gap: 12, paddingTop: 8 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primaryActive} />
          }
          renderItem={({ item, index }) => {
            const isActive = activeBookId === item.id;
            return (
            <TouchableOpacity
              testID={`book-row-${item.id}`}
              style={[
                styles.listRow,
                {
                  backgroundColor: colors.surface,
                  borderColor: isActive ? colors.primaryActive : colors.border,
                  borderWidth: isActive ? 2 : 1,
                },
              ]}
              onPress={() => router.push(`/player/${item.id}`)}
              onLongPress={() => onLongPress(item)}
              activeOpacity={0.85}
            >
              <Image source={{ uri: coverFor(item) }} style={styles.listCover} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text numberOfLines={2} style={[styles.listTitle, { color: colors.textPrimary }]}>
                  {item.title}
                </Text>
                {item.author ? (
                  <Text numberOfLines={1} style={[styles.listAuthor, { color: colors.textSecondary }]}>
                    {item.author}
                  </Text>
                ) : null}
                <Text style={[styles.gridMeta, { color: isActive ? colors.primaryActive : colors.textSecondary }]}>
                  {isActive
                    ? (activeIsPlaying ? t('library.nowPlaying') : t('library.paused'))
                    : t('library.book.wordCount', { percent: progressPct(item), count: item.word_count })}
                </Text>
                <View style={[styles.progressTrack, { backgroundColor: colors.border, marginTop: 2 }]}>
                  <View
                    style={[
                      styles.progressFill,
                      { backgroundColor: colors.primaryActive, width: `${progressPct(item)}%` },
                    ]}
                  />
                </View>
              </View>
              {manualMode && !query.trim() ? (
                <View style={{ gap: 4 }}>
                  <TouchableOpacity
                    disabled={index === 0}
                    onPress={() => moveBook(item.id, -1)}
                    style={[
                      styles.reorderBtn,
                      { borderColor: colors.border, opacity: index === 0 ? 0.35 : 1 },
                    ]}
                  >
                    <ArrowUp color={colors.textPrimary} size={14} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    disabled={index === sortedBooks.length - 1}
                    onPress={() => moveBook(item.id, 1)}
                    style={[
                      styles.reorderBtn,
                      {
                        borderColor: colors.border,
                        opacity: index === sortedBooks.length - 1 ? 0.35 : 1,
                      },
                    ]}
                  >
                    <ArrowDown color={colors.textPrimary} size={14} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity onPress={() => onLongPress(item)} style={styles.moreBtn}>
                  <MoreVertical color={colors.textSecondary} size={18} />
                </TouchableOpacity>
              )}
              {/* PATCH (v6.4): if this row is the live book, the action
                  button toggles play/pause; otherwise it stays decorative
                  (the whole row navigates to the player on press). */}
              <TouchableOpacity
                testID={`book-row-action-${item.id}`}
                disabled={!isActive}
                onPress={(e) => {
                  if (!isActive) return;
                  e.stopPropagation();
                  player.toggle();
                }}
                style={[styles.playBtnSmall, { backgroundColor: colors.primaryActive }]}
              >
                {isActive && activeIsPlaying ? (
                  <Pause color="#0A0A0C" size={16} fill="#0A0A0C" />
                ) : (
                  <Play color="#0A0A0C" size={16} fill="#0A0A0C" />
                )}
              </TouchableOpacity>
            </TouchableOpacity>
            );
          }}
        />
      )}

      <Modal transparent visible={!!actionFor} animationType="fade" onRequestClose={closeAction}>
        <Pressable style={styles.sheetBg} onPress={closeAction}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.sheetTitle, { color: colors.textPrimary }]} numberOfLines={1}>
              {actionFor?.title}
            </Text>
            {actionFor?.author ? (
              <Text style={[styles.sheetSubtitle, { color: colors.textSecondary }]} numberOfLines={1}>
                {actionFor.author}
              </Text>
            ) : null}

            <TouchableOpacity
              style={styles.sheetRow}
              onPress={() => {
                const id = actionFor!.id;
                closeAction();
                router.push(`/player/${id}`);
              }}
            >
              <Play color={colors.primaryActive} size={18} fill={colors.primaryActive} />
              <Text style={[styles.sheetRowLabel, { color: colors.textPrimary }]}>{t('common.play')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.sheetRow}
              onPress={() => {
                const b = actionFor!;
                closeAction();
                setEditFor(b);
              }}
            >
              <Edit3 color={colors.textSecondary} size={18} />
              <Text style={[styles.sheetRowLabel, { color: colors.textPrimary }]}>{t('common.edit')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.sheetRow}
              onPress={() => {
                const b = actionFor!;
                closeAction();
                handleDelete(b);
              }}
            >
              <Trash2 color={colors.danger} size={18} />
              <Text style={[styles.sheetRowLabel, { color: colors.danger }]}>{t('common.delete')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.sheetRow, { justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, marginTop: 4 }]}
              onPress={closeAction}
            >
              <Text style={[styles.sheetRowLabel, { color: colors.textSecondary, fontWeight: '600' }]}>
                {t('common.cancel')}
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      <BookEditModal
        book={editFor}
        folders={folders}
        onClose={() => setEditFor(null)}
        onSaved={() => {
          setEditFor(null);
          reload();
        }}
      />
    </View>
  );
}

function SortChip({
  icon,
  label,
  active,
  onPress,
  colors,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onPress: () => void;
  colors: any;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: active ? colors.primaryActive : colors.border,
          backgroundColor: active ? colors.primaryActive + '22' : 'transparent',
        },
      ]}
    >
      {icon}
      <Text style={[styles.chipLabel, { color: active ? colors.primaryActive : colors.textSecondary }]}>
        {label}
      </Text>
      {active ? <Check color={colors.primaryActive} size={12} /> : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    gap: 10,
    paddingHorizontal: 24,
    paddingBottom: 8,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    height: 42,
    borderRadius: 999,
    borderWidth: 1,
  },
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  controlsRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  sortChips: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    height: 32,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.2 },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 16 },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  gridCard: { flex: 1, gap: 8 },
  cover: { width: '100%', aspectRatio: 2 / 3, borderRadius: 12 },
  progressTrack: { height: 3, width: '100%', borderRadius: 999, overflow: 'hidden' },
  progressFill: { height: '100%' },
  gridTitle: { fontSize: 14, fontWeight: '600', lineHeight: 18 },
  gridAuthor: { fontSize: 12, fontStyle: 'italic' },
  gridMeta: { fontSize: 11, letterSpacing: 0.5 },
  gridReorder: { flexDirection: 'row', gap: 6, justifyContent: 'center' },
  reorderBtn: { width: 32, height: 32, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  listRow: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 16, alignItems: 'center', borderWidth: 1 },
  listCover: { width: 56, height: 84, borderRadius: 8 },
  listTitle: { fontSize: 15, fontWeight: '600' },
  listAuthor: { fontSize: 12, fontStyle: 'italic' },
  moreBtn: { width: 32, height: 32, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  playBtnSmall: { width: 40, height: 40, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  // PATCH (v6.4): "now-playing" / "paused" overlay sitting at the top-left
  // of the grid-card cover. Same shape as a pill button so it reads as an
  // active state badge rather than a meta-data tag.
  nowBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    maxWidth: '90%',
  },
  nowBadgeLabel: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  sheetBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { padding: 16, borderTopLeftRadius: 24, borderTopRightRadius: 24, borderWidth: 1, gap: 4, paddingBottom: 32 },
  sheetTitle: { fontSize: 16, fontWeight: '700', paddingHorizontal: 8, paddingTop: 4 },
  sheetSubtitle: { fontSize: 13, fontStyle: 'italic', paddingHorizontal: 8, marginBottom: 8 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, paddingHorizontal: 8 },
  sheetRowLabel: { fontSize: 15, fontWeight: '500' },
});
