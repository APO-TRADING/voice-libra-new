import { router, useFocusEffect } from 'expo-router';
import { RefreshCcw } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, BookSummary, Folder } from '../../src/api/client';
import BookList from '../../src/components/BookList';
import { useTheme } from '../../src/contexts/ThemeContext';
import { useT } from '../../src/i18n';

function bookCountLabel(t: ReturnType<typeof useT>, n: number) {
  if (n === 0) return t('library.bookCount.zero');
  return n === 1 ? t('library.bookCount.one', { n }) : t('library.bookCount.other', { n });
}

export default function Library() {
  const { colors } = useTheme();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, fs] = await Promise.all([api.listBooks(), api.listFolders()]);
      setBooks(list);
      setFolders(fs);
    } catch (e) {
      console.warn('[Library] load failed:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const empty = !loading && books.length === 0;

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 8 }]}
      testID="library-screen"
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t('library.title')}</Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {bookCountLabel(t, books.length)}
          </Text>
        </View>
        <TouchableOpacity
          testID="library-refresh"
          onPress={onRefresh}
          style={[styles.iconBtn, { borderColor: colors.border }]}
        >
          <RefreshCcw color={colors.textSecondary} size={18} />
        </TouchableOpacity>
      </View>

      {empty ? (
        <View style={styles.center}>
          <Image
            source={{
              uri: 'https://images.unsplash.com/photo-1682256781111-9d20db9ca5a0?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NTYxNzV8MHwxfHNlYXJjaHwyfHxlbXB0eSUyMGJvb2tzaGVsZiUyMG1pbmltYWx8ZW58MHx8fHwxNzc4NDI3MzcxfDA&ixlib=rb-4.1.0&q=85',
            }}
            style={styles.emptyImg}
          />
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>{t('library.empty.title')}</Text>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {t('library.empty.body')}
          </Text>
          <TouchableOpacity
            testID="empty-upload-cta"
            style={[styles.cta, { backgroundColor: colors.primaryActive }]}
            onPress={() => router.push('/upload')}
          >
            <Text style={[styles.ctaText, { color: '#0A0A0C' }]}>{t('library.empty.cta')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <BookList
          books={books}
          folders={folders}
          loading={loading}
          refreshing={refreshing}
          onRefresh={onRefresh}
          reload={load}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingHorizontal: 24,
    paddingBottom: 12,
    gap: 12,
  },
  // PATCH (beppe-audiobooks v6): title enlarged from 36 → 42 since the
  // duplicate small "Libreria" navigation header has been removed.
  title: { fontSize: 42, fontWeight: '800', letterSpacing: -0.8 },
  subtitle: { fontSize: 13, marginTop: 4, letterSpacing: 0.3 },
  iconBtn: { width: 40, height: 40, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 16 },
  emptyImg: { width: 220, height: 160, borderRadius: 24, opacity: 0.85 },
  emptyTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  emptyText: { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  cta: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 999, marginTop: 8 },
  ctaText: { fontSize: 14, fontWeight: '700', letterSpacing: 0.3 },
});
