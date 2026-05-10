import { router, useFocusEffect } from 'expo-router';
import { Grid3x3, List, MoreVertical, Play, RefreshCcw } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, BookSummary } from '../../src/api/client';
import { useTheme } from '../../src/contexts/ThemeContext';

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

export default function Library() {
  const { colors, viewMode, setViewMode } = useTheme();
  const insets = useSafeAreaInsets();
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.listBooks();
      setBooks(list);
    } catch (e) {
      console.warn('list books failed', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  const empty = !loading && books.length === 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 8 }]} testID="library-screen">
      <View style={styles.header}>
        <View>
          <Text style={[styles.title, { color: colors.textPrimary }]}>Libreria</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {books.length} {books.length === 1 ? 'libro' : 'libri'}
          </Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            testID="library-refresh"
            onPress={onRefresh}
            style={[styles.iconBtn, { borderColor: colors.border }]}
          >
            <RefreshCcw color={colors.textSecondary} size={18} />
          </TouchableOpacity>
          <TouchableOpacity
            testID="library-grid-toggle"
            onPress={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
            style={[styles.iconBtn, { borderColor: colors.border }]}
          >
            {viewMode === 'grid' ? (
              <List color={colors.textSecondary} size={18} />
            ) : (
              <Grid3x3 color={colors.textSecondary} size={18} />
            )}
          </TouchableOpacity>
        </View>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primaryActive} />
        </View>
      ) : empty ? (
        <View style={styles.center}>
          <Image
            source={{ uri: 'https://images.unsplash.com/photo-1682256781111-9d20db9ca5a0?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NTYxNzV8MHwxfHNlYXJjaHwyfHxlbXB0eSUyMGJvb2tzaGVsZiUyMG1pbmltYWx8ZW58MHx8fHwxNzc4NDI3MzcxfDA&ixlib=rb-4.1.0&q=85' }}
            style={styles.emptyImg}
          />
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>La tua libreria è vuota</Text>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            Carica un eBook (PDF, EPUB, DOCX o TXT) per iniziare ad ascoltare.
          </Text>
          <TouchableOpacity
            testID="empty-upload-cta"
            style={[styles.cta, { backgroundColor: colors.primaryActive }]}
            onPress={() => router.push('/upload')}
          >
            <Text style={[styles.ctaText, { color: '#0A0A0C' }]}>Carica un libro</Text>
          </TouchableOpacity>
        </View>
      ) : viewMode === 'grid' ? (
        <FlatList
          key="grid"
          data={books}
          numColumns={2}
          keyExtractor={(b) => b.id}
          columnWrapperStyle={{ gap: 16, paddingHorizontal: 24 }}
          contentContainerStyle={{ gap: 24, paddingVertical: 16, paddingBottom: 96 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primaryActive} />}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`book-card-${item.id}`}
              style={styles.gridCard}
              onPress={() => router.push(`/player/${item.id}`)}
              activeOpacity={0.85}
            >
              <Image source={{ uri: coverFor(item) }} style={[styles.cover, { backgroundColor: colors.surface }]} />
              <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
                <View style={[styles.progressFill, { backgroundColor: colors.primaryActive, width: `${progressPct(item)}%` }]} />
              </View>
              <Text numberOfLines={2} style={[styles.gridTitle, { color: colors.textPrimary }]}>{item.title}</Text>
              <Text style={[styles.gridMeta, { color: colors.textSecondary }]}>{progressPct(item)}% • {item.sentence_count} frasi</Text>
            </TouchableOpacity>
          )}
        />
      ) : (
        <FlatList
          key="list"
          data={books}
          keyExtractor={(b) => b.id}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 96, gap: 16, paddingTop: 8 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primaryActive} />}
          renderItem={({ item }) => (
            <TouchableOpacity
              testID={`book-row-${item.id}`}
              style={[styles.listRow, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={() => router.push(`/player/${item.id}`)}
              activeOpacity={0.85}
            >
              <Image source={{ uri: coverFor(item) }} style={styles.listCover} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text numberOfLines={2} style={[styles.listTitle, { color: colors.textPrimary }]}>{item.title}</Text>
                <Text style={[styles.gridMeta, { color: colors.textSecondary }]}>
                  {progressPct(item)}% • {item.word_count} parole
                </Text>
                <View style={[styles.progressTrack, { backgroundColor: colors.border, marginTop: 2 }]}>
                  <View style={[styles.progressFill, { backgroundColor: colors.primaryActive, width: `${progressPct(item)}%` }]} />
                </View>
              </View>
              <View style={[styles.playBtnSmall, { backgroundColor: colors.primaryActive }]}>
                <Play color="#0A0A0C" size={16} fill="#0A0A0C" />
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', paddingHorizontal: 24, paddingBottom: 16 },
  title: { fontSize: 36, fontWeight: '700', letterSpacing: -0.5 },
  subtitle: { fontSize: 13, marginTop: 4, letterSpacing: 0.3 },
  headerActions: { flexDirection: 'row', gap: 8 },
  iconBtn: { width: 40, height: 40, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 16 },
  emptyImg: { width: 220, height: 160, borderRadius: 24, opacity: 0.85 },
  emptyTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  cta: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 999, marginTop: 8 },
  ctaText: { fontSize: 14, fontWeight: '700', letterSpacing: 0.3 },
  gridCard: { flex: 1, gap: 8 },
  cover: { width: '100%', aspectRatio: 2 / 3, borderRadius: 12 },
  progressTrack: { height: 3, width: '100%', borderRadius: 999, overflow: 'hidden' },
  progressFill: { height: '100%' },
  gridTitle: { fontSize: 14, fontWeight: '600', lineHeight: 18 },
  gridMeta: { fontSize: 11, letterSpacing: 0.5 },
  listRow: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: 16, alignItems: 'center', borderWidth: 1 },
  listCover: { width: 56, height: 84, borderRadius: 8 },
  listTitle: { fontSize: 15, fontWeight: '600' },
  playBtnSmall: { width: 40, height: 40, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
});
