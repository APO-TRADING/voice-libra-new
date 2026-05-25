import { router, useFocusEffect } from 'expo-router';
import { ChevronRight, Folder as FolderIcon, FolderPlus, MoreVertical } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api, BookSummary, Folder } from '../../src/api/client';
import MarqueeText from '../../src/components/MarqueeText';
import { useTheme } from '../../src/contexts/ThemeContext';
import { useT } from '../../src/i18n';

export default function FoldersScreen() {
  const { colors } = useTheme();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [unfiled, setUnfiled] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Folder | null>(null);
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    try {
      const [fs, books] = await Promise.all([api.listFolders(), api.listBooks()]);
      setFolders(fs);
      const c: Record<string, number> = {};
      let n = 0;
      books.forEach((b: BookSummary) => {
        if (b.folder_id) c[b.folder_id] = (c[b.folder_id] || 0) + 1;
        else n += 1;
      });
      setCounts(c);
      setUnfiled(n);
    } catch (e) {
      console.warn(e);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const countLabel = (n: number) =>
    n === 0
      ? t('library.bookCount.zero')
      : n === 1
      ? t('folders.folderCount.one', { n })
      : t('folders.folderCount.other', { n });

  const submit = async () => {
    const nm = name.trim();
    if (!nm) return;
    try {
      if (editing) await api.updateFolder(editing.id, nm);
      else await api.createFolder(nm);
      setName('');
      setEditing(null);
      setCreating(false);
      load();
    } catch (e: any) {
      Alert.alert(t('common.error'), String(e?.message || e));
    }
  };

  const remove = (f: Folder) => {
    Alert.alert(t('folders.delete.confirmTitle'), t('folders.delete.confirmBody', { name: f.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.delete'), style: 'destructive', onPress: async () => { await api.deleteFolder(f.id); load(); } },
    ]);
  };

  // v2.6 (cosmetic): wrap rename + delete behind a single 3-dot menu so the
  // folder name has the full row width on a single line. Previously two
  // inline icon buttons (Pencil + Trash2) were eating ~80px of horizontal
  // space and truncating long folder names.
  const openMenu = (f: Folder) => {
    Alert.alert(f.name, undefined, [
      {
        text: t('folders.rename'),
        onPress: () => {
          setEditing(f);
          setName(f.name);
          setCreating(true);
        },
      },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => remove(f),
      },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  };

  return (
    <View style={[styles.c, { backgroundColor: colors.background, paddingTop: insets.top + 8 }]} testID="folders-screen">
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t('folders.title')}</Text>
        <TouchableOpacity
          testID="create-folder-btn"
          onPress={() => { setEditing(null); setName(''); setCreating(true); }}
          style={[styles.addBtn, { backgroundColor: colors.primaryActive }]}
        >
          <FolderPlus color="#0A0A0C" size={18} />
          <Text style={[styles.addLabel, { color: '#0A0A0C' }]}>{t('folders.new')}</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={folders}
        keyExtractor={(f) => f.id}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 96, gap: 12, paddingTop: 8 }}
        ListHeaderComponent={
          <TouchableOpacity
            testID="folder-unfiled"
            onPress={() => router.push('/folders/none' as any)}
            activeOpacity={0.85}
            style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
          >
            <View style={[styles.iconCircle, { backgroundColor: colors.surface2 }]}>
              <FolderIcon color={colors.textSecondary} size={20} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: colors.textPrimary }]}>{t('folders.unfiled')}</Text>
              <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>{countLabel(unfiled)}</Text>
            </View>
            <ChevronRight color={colors.textSecondary} size={18} />
          </TouchableOpacity>
        }
        ListEmptyComponent={
          <View style={{ alignItems: 'center', paddingVertical: 64 }}>
            <Text style={[styles.empty, { color: colors.textSecondary }]}>
              {t('folders.empty')}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => router.push(`/folders/${item.id}` as any)}
            activeOpacity={0.85}
            style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}
            testID={`folder-row-${item.id}`}
          >
            <View style={[styles.iconCircle, { backgroundColor: colors.surface2 }]}>
              <FolderIcon color={colors.primaryActive} size={20} />
            </View>
            <View style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
              {/* v2.7: long folder names auto-scroll horizontally (marquee).
                  Short names render as a plain Text — zero overhead.
                  v2.7.6: overflow:'hidden' on this wrapper gives the
                  Marquee a CLEAR horizontal boundary so its measurer can
                  detect overflow and trigger the slide. Without it the
                  flex child can momentarily widen past its parent on
                  Android causing the marquee logic to think the text
                  fits and skip the animation. The row's gap:12 takes
                  care of the spacing toward the 3-dot menu. */}
              <MarqueeText style={[styles.rowTitle, { color: colors.textPrimary }]}>
                {item.name}
              </MarqueeText>
              <Text style={[styles.rowMeta, { color: colors.textSecondary }]} numberOfLines={1} ellipsizeMode="tail">{countLabel(counts[item.id] || 0)}</Text>
            </View>
            {/* v2.6: single 3-dot menu replaces inline Pencil + Trash2 icons */}
            <TouchableOpacity
              testID={`folder-menu-${item.id}`}
              onPress={(e) => {
                e.stopPropagation();
                openMenu(item);
              }}
              style={[styles.smallBtn, { borderColor: colors.border }]}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <MoreVertical color={colors.textSecondary} size={18} />
            </TouchableOpacity>
            <ChevronRight color={colors.textSecondary} size={18} />
          </TouchableOpacity>
        )}
      />

      <Modal transparent visible={creating} animationType="fade" onRequestClose={() => setCreating(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalBg}
        >
          <View style={[styles.modal, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              {editing ? t('folders.rename') : t('folders.create')}
            </Text>
            <TextInput
              testID="folder-name-input"
              value={name}
              onChangeText={setName}
              placeholder={t('folders.name.placeholder')}
              placeholderTextColor={colors.textSecondary}
              style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.background }]}
              autoFocus
            />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <TouchableOpacity
                onPress={() => { setCreating(false); setEditing(null); setName(''); }}
                style={[styles.modalBtn, { borderColor: colors.border, borderWidth: 1 }]}
              >
                <Text style={[styles.modalBtnLabel, { color: colors.textPrimary }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="folder-submit-btn"
                onPress={submit}
                style={[styles.modalBtn, { backgroundColor: colors.primaryActive }]}
              >
                <Text style={[styles.modalBtnLabel, { color: '#0A0A0C', fontWeight: '700' }]}>
                  {editing ? t('common.save') : t('folders.create.cta')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, paddingBottom: 8 },
  // PATCH (beppe-audiobooks v6): title enlarged to match the Library header.
  title: { fontSize: 42, fontWeight: '800', letterSpacing: -0.8 },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, height: 40, borderRadius: 999 },
  addLabel: { fontSize: 13, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, borderWidth: 1 },
  iconCircle: { width: 44, height: 44, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowMeta: { fontSize: 12, marginTop: 2, letterSpacing: 0.3 },
  smallBtn: { width: 36, height: 36, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { fontSize: 14 },
  modalBg: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 24 },
  modal: { width: '100%', maxWidth: 380, borderRadius: 24, padding: 24, gap: 16, borderWidth: 1 },
  modalTitle: { fontSize: 20, fontWeight: '700' },
  input: { height: 48, borderRadius: 12, paddingHorizontal: 14, borderWidth: 1, fontSize: 15 },
  modalBtn: { flex: 1, height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  modalBtnLabel: { fontSize: 14, fontWeight: '600' },
});
