// Modal to edit a book's title, author, folder and cover.
import * as ImagePicker from 'expo-image-picker';
import { ImageIcon, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import {
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
import { api, BookSummary, Folder } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { useT } from '../i18n';

type Props = {
  book: BookSummary | null;
  folders: Folder[];
  onClose: () => void;
  onSaved: () => void;
};

export default function BookEditModal({ book, folders, onClose, onSaved }: Props) {
  const { colors } = useTheme();
  const t = useT();
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (book) {
      setTitle(book.title);
      setAuthor(book.author || '');
      setCoverUrl(book.cover_url || '');
      setFolderId(book.folder_id);
    }
  }, [book]);

  const pickCover = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(t('upload.gallery.deniedTitle'), t('upload.gallery.denied'));
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.7,
      allowsEditing: true,
      aspect: [2, 3],
    });
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    if (a.base64) {
      const mime = a.mimeType || 'image/jpeg';
      setCoverUrl(`data:${mime};base64,${a.base64}`);
    } else if (a.uri) {
      setCoverUrl(a.uri);
    }
  };

  const submit = async () => {
    if (!book) return;
    const tx = title.trim();
    if (!tx) {
      Alert.alert(t('bookEdit.titleRequired.title'), t('bookEdit.titleRequired'));
      return;
    }
    setSaving(true);
    try {
      await api.updateBook(book.id, {
        title: tx.slice(0, 200),
        author: author.trim() || null,
        cover_url: coverUrl.trim() || null,
        folder_id: folderId,
      });
      setSaving(false);
      onSaved();
    } catch (e: any) {
      setSaving(false);
      Alert.alert(t('common.error'), String(e?.message || e));
    }
  };

  return (
    <Modal transparent visible={!!book} animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.bg}
      >
        <View style={[styles.modal, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 20, gap: 12 }}
          >
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>{t('bookEdit.title')}</Text>

            <Text style={[styles.label, { color: colors.textSecondary }]}>{t('bookEdit.field.title')}</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder={t('upload.field.title.placeholder')}
              placeholderTextColor={colors.textSecondary}
              style={[
                styles.input,
                { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.background },
              ]}
            />

            <Text style={[styles.label, { color: colors.textSecondary }]}>{t('bookEdit.field.author')}</Text>
            <TextInput
              value={author}
              onChangeText={setAuthor}
              placeholder={t('bookEdit.field.author.placeholder')}
              placeholderTextColor={colors.textSecondary}
              style={[
                styles.input,
                { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.background },
              ]}
            />

            <Text style={[styles.label, { color: colors.textSecondary }]}>{t('bookEdit.field.cover')}</Text>
            <View style={styles.coverRow}>
              <View style={[styles.coverPreview, { backgroundColor: colors.background, borderColor: colors.border }]}>
                {coverUrl ? (
                  <>
                    <Image source={{ uri: coverUrl }} style={styles.coverImg} />
                    <TouchableOpacity onPress={() => setCoverUrl('')} style={styles.coverRemove}>
                      <X color="#fff" size={14} />
                    </TouchableOpacity>
                  </>
                ) : (
                  <ImageIcon color={colors.textSecondary} size={28} />
                )}
              </View>
              <View style={{ flex: 1, gap: 8 }}>
                <TouchableOpacity
                  onPress={pickCover}
                  style={[styles.smallBtn, { borderColor: colors.border, backgroundColor: colors.background }]}
                >
                  <Text style={[styles.smallBtnLabel, { color: colors.textPrimary }]}>{t('upload.field.cover.gallery')}</Text>
                </TouchableOpacity>
                <TextInput
                  value={coverUrl.startsWith('data:') ? '' : coverUrl}
                  onChangeText={setCoverUrl}
                  placeholder={t('upload.field.cover.url')}
                  placeholderTextColor={colors.textSecondary}
                  style={[
                    styles.input,
                    { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.background, marginBottom: 0 },
                  ]}
                  autoCapitalize="none"
                />
              </View>
            </View>

            <Text style={[styles.label, { color: colors.textSecondary }]}>{t('bookEdit.field.folder')}</Text>
            <View style={styles.chips}>
              <TouchableOpacity
                onPress={() => setFolderId(null)}
                style={[
                  styles.chip,
                  {
                    borderColor: !folderId ? colors.primaryActive : colors.border,
                    backgroundColor: colors.background,
                  },
                ]}
              >
                <Text style={[styles.chipLabel, { color: !folderId ? colors.primaryActive : colors.textPrimary }]}>
                  {t('upload.field.folder.none')}
                </Text>
              </TouchableOpacity>
              {folders.map((f) => (
                <TouchableOpacity
                  key={f.id}
                  onPress={() => setFolderId(f.id)}
                  style={[
                    styles.chip,
                    {
                      borderColor: folderId === f.id ? colors.primaryActive : colors.border,
                      backgroundColor: colors.background,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipLabel,
                      { color: folderId === f.id ? colors.primaryActive : colors.textPrimary },
                    ]}
                  >
                    {f.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
              <TouchableOpacity
                onPress={onClose}
                style={[styles.actionBtn, { borderColor: colors.border, borderWidth: 1 }]}
              >
                <Text style={[styles.actionLabel, { color: colors.textPrimary }]}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submit}
                disabled={saving}
                style={[styles.actionBtn, { backgroundColor: colors.primaryActive, opacity: saving ? 0.6 : 1 }]}
              >
                <Text style={[styles.actionLabel, { color: '#0A0A0C', fontWeight: '700' }]}>
                  {saving ? t('bookEdit.saving') : t('common.save')}
                </Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.65)', paddingHorizontal: 16 },
  modal: { width: '100%', maxWidth: 480, maxHeight: '92%', borderRadius: 24, borderWidth: 1, overflow: 'hidden' },
  modalTitle: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 1, marginTop: 4 },
  input: { height: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 15 },
  coverRow: { flexDirection: 'row', gap: 12 },
  coverPreview: { width: 84, height: 126, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  coverImg: { width: '100%', height: '100%' },
  coverRemove: { position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center' },
  smallBtn: { height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  smallBtnLabel: { fontSize: 13, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chipLabel: { fontSize: 13, fontWeight: '600' },
  actionBtn: { flex: 1, height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  actionLabel: { fontSize: 14, fontWeight: '600' },
});
