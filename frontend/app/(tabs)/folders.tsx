import { useFocusEffect } from 'expo-router';
import { Folder as FolderIcon, FolderPlus, Pencil, Trash2 } from 'lucide-react-native';
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
import { useTheme } from '../../src/contexts/ThemeContext';

export default function FoldersScreen() {
  const { colors } = useTheme();
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

  const submit = async () => {
    const t = name.trim();
    if (!t) return;
    try {
      if (editing) await api.updateFolder(editing.id, t);
      else await api.createFolder(t);
      setName('');
      setEditing(null);
      setCreating(false);
      load();
    } catch (e: any) {
      Alert.alert('Errore', String(e?.message || e));
    }
  };

  const remove = (f: Folder) => {
    Alert.alert('Elimina cartella', `Eliminare "${f.name}"? I libri non verranno cancellati.`, [
      { text: 'Annulla', style: 'cancel' },
      { text: 'Elimina', style: 'destructive', onPress: async () => { await api.deleteFolder(f.id); load(); } },
    ]);
  };

  return (
    <View style={[styles.c, { backgroundColor: colors.background, paddingTop: insets.top + 8 }]} testID="folders-screen">
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>Cartelle</Text>
        <TouchableOpacity
          testID="create-folder-btn"
          onPress={() => { setEditing(null); setName(''); setCreating(true); }}
          style={[styles.addBtn, { backgroundColor: colors.primaryActive }]}
        >
          <FolderPlus color="#0A0A0C" size={18} />
          <Text style={[styles.addLabel, { color: '#0A0A0C' }]}>Nuova</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={folders}
        keyExtractor={(f) => f.id}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 96, gap: 12, paddingTop: 8 }}
        ListHeaderComponent={
          <View style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.iconCircle, { backgroundColor: colors.surface2 }]}>
              <FolderIcon color={colors.textSecondary} size={20} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: colors.textPrimary }]}>Senza cartella</Text>
              <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>{unfiled} libri</Text>
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={{ alignItems: 'center', paddingVertical: 64 }}>
            <Text style={[styles.empty, { color: colors.textSecondary }]}>
              Nessuna cartella. Toccare "Nuova" per crearne una.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]} testID={`folder-row-${item.id}`}>
            <View style={[styles.iconCircle, { backgroundColor: colors.surface2 }]}>
              <FolderIcon color={colors.primaryActive} size={20} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowTitle, { color: colors.textPrimary }]}>{item.name}</Text>
              <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>{counts[item.id] || 0} libri</Text>
            </View>
            <TouchableOpacity
              testID={`folder-edit-${item.id}`}
              onPress={() => { setEditing(item); setName(item.name); setCreating(true); }}
              style={[styles.smallBtn, { borderColor: colors.border }]}
            >
              <Pencil color={colors.textSecondary} size={16} />
            </TouchableOpacity>
            <TouchableOpacity
              testID={`folder-delete-${item.id}`}
              onPress={() => remove(item)}
              style={[styles.smallBtn, { borderColor: colors.border }]}
            >
              <Trash2 color={colors.danger} size={16} />
            </TouchableOpacity>
          </View>
        )}
      />

      <Modal transparent visible={creating} animationType="fade" onRequestClose={() => setCreating(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.modalBg}
        >
          <View style={[styles.modal, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              {editing ? 'Rinomina cartella' : 'Nuova cartella'}
            </Text>
            <TextInput
              testID="folder-name-input"
              value={name}
              onChangeText={setName}
              placeholder="Nome cartella"
              placeholderTextColor={colors.textSecondary}
              style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.background }]}
              autoFocus
            />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <TouchableOpacity
                onPress={() => { setCreating(false); setEditing(null); setName(''); }}
                style={[styles.modalBtn, { borderColor: colors.border, borderWidth: 1 }]}
              >
                <Text style={[styles.modalBtnLabel, { color: colors.textPrimary }]}>Annulla</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="folder-submit-btn"
                onPress={submit}
                style={[styles.modalBtn, { backgroundColor: colors.primaryActive }]}
              >
                <Text style={[styles.modalBtnLabel, { color: '#0A0A0C', fontWeight: '700' }]}>
                  {editing ? 'Salva' : 'Crea'}
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
  title: { fontSize: 36, fontWeight: '700', letterSpacing: -0.5 },
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
