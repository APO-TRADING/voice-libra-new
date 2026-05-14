// Folder detail screen — uses the BookList component.
// Route: /folders/<folderId>  OR  /folders/none
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ChevronLeft, Plus } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, BookSummary, Folder } from '../../src/api/client';
import BookList from '../../src/components/BookList';
import { useTheme } from '../../src/contexts/ThemeContext';
import { useT } from '../../src/i18n';

export default function FolderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderName, setFolderName] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const isUnfiled = id === 'none';

  const load = useCallback(async () => {
    try {
      const [list, fs] = await Promise.all([
        api.listBooksSorted({ folderId: id }),
        api.listFolders(),
      ]);
      setBooks(list);
      setFolders(fs);
      if (isUnfiled) {
        setFolderName(t('folders.unfiled'));
      } else if (id) {
        const f = await api.getFolder(id);
        setFolderName(f?.name || '—');
      }
    } catch (e) {
      console.warn('[Folder] load failed:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id, isUnfiled, t]);

  useEffect(() => { load(); }, [load]);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const countLabel =
    books.length === 0
      ? t('library.bookCount.zero')
      : books.length === 1
      ? t('folders.folderCount.one', { n: books.length })
      : t('folders.folderCount.other', { n: books.length });

  return (
    <View
      style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top + 8 }]}
      testID={`folder-screen-${id}`}
    >
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 }}>
          <TouchableOpacity
            onPress={() => router.back()}
            style={[styles.backBtn, { borderColor: colors.border }]}
            testID="folder-back-btn"
          >
            <ChevronLeft color={colors.textPrimary} size={20} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={[styles.eyebrow, { color: colors.textSecondary }]}>{t('folders.eyebrow')}</Text>
            <Text numberOfLines={1} style={[styles.title, { color: colors.textPrimary }]}>
              {folderName}
            </Text>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{countLabel}</Text>
          </View>
        </View>
        <TouchableOpacity
          onPress={() => router.push('/upload')}
          style={[styles.addBtn, { backgroundColor: colors.primaryActive }]}
          testID="folder-add-book"
        >
          <Plus color="#0A0A0C" size={18} />
        </TouchableOpacity>
      </View>

      <BookList
        books={books}
        folders={folders}
        loading={loading}
        refreshing={refreshing}
        onRefresh={onRefresh}
        reload={load}
        emptyMessage={
          isUnfiled
            ? t('folders.empty.unfiled')
            : t('folders.empty.inside', { name: folderName })
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eyebrow: { fontSize: 10, fontWeight: '700', letterSpacing: 1.5 },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.3, marginTop: 2 },
  subtitle: { fontSize: 12, letterSpacing: 0.3, marginTop: 2 },
});
