import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { router, useFocusEffect } from 'expo-router';
import { FileText, ImageIcon, Upload as UploadIcon, X } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
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
import { useTheme } from '../../src/contexts/ThemeContext';
import { useT } from '../../src/i18n';

type PickedFile = { uri: string; name: string; mimeType?: string; size?: number };

export default function UploadScreen() {
  const { colors } = useTheme();
  const t = useT();
  const insets = useSafeAreaInsets();
  const [file, setFile] = useState<PickedFile | null>(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [coverUrl, setCoverUrl] = useState('');
  const [folderId, setFolderId] = useState<string | undefined>();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [busy, setBusy] = useState(false);

  useFocusEffect(useCallback(() => {
    api.listFolders().then(setFolders).catch(() => {});
  }, []));

  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: [
        'text/plain',
        'application/pdf',
        'application/epub+zip',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '*/*',
      ],
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    setFile({ uri: a.uri, name: a.name, mimeType: a.mimeType ?? undefined, size: a.size ?? undefined });
    if (!title) setTitle(a.name.replace(/\.[^.]+$/, ''));
  };

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
    if (!file) {
      Alert.alert(t('upload.missing.title'), t('upload.missing'));
      return;
    }
    setBusy(true);
    try {
      const book = await api.uploadBook(file, {
        title: title.trim() || undefined,
        author: author.trim() || undefined,
        cover_url: coverUrl.trim() || undefined,
        folder_id: folderId,
      });
      setBusy(false);
      Alert.alert(t('upload.done.title'), t('upload.done.body', { title: book.title }), [
        { text: t('common.play'), onPress: () => router.replace(`/player/${book.id}`) },
        {
          text: t('common.ok'),
          style: 'cancel',
          onPress: () => {
            setFile(null);
            setTitle('');
            setAuthor('');
            setCoverUrl('');
            router.replace('/');
          },
        },
      ]);
    } catch (e: any) {
      setBusy(false);
      Alert.alert(t('common.error'), String(e?.message || e));
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
      <ScrollView
        style={[styles.c, { backgroundColor: colors.background }]}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 96, paddingHorizontal: 24 }}
        keyboardShouldPersistTaps="handled"
        testID="upload-screen"
      >
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t('upload.title')}</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {t('upload.subtitle')}
        </Text>

        <TouchableOpacity
          testID="pick-file-btn"
          style={[styles.dropzone, { borderColor: file ? colors.primaryActive : colors.border, backgroundColor: colors.surface }]}
          onPress={pickFile}
          activeOpacity={0.85}
        >
          <View style={[styles.dropIcon, { backgroundColor: colors.surface2 }]}>
            <FileText color={colors.primaryActive} size={28} />
          </View>
          <Text style={[styles.dropTitle, { color: colors.textPrimary }]}>
            {file ? file.name : t('upload.pick.placeholder')}
          </Text>
          <Text style={[styles.dropMeta, { color: colors.textSecondary }]}>
            {file ? `${((file.size || 0) / 1024).toFixed(0)} KB` : t('upload.pick.hint')}
          </Text>
        </TouchableOpacity>

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('upload.field.title')}</Text>
        <TextInput
          testID="upload-title-input"
          value={title}
          onChangeText={setTitle}
          placeholder={t('upload.field.title.placeholder')}
          placeholderTextColor={colors.textSecondary}
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.surface }]}
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('upload.field.author')}</Text>
        <TextInput
          testID="upload-author-input"
          value={author}
          onChangeText={setAuthor}
          placeholder={t('upload.field.author.placeholder')}
          placeholderTextColor={colors.textSecondary}
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.surface }]}
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('upload.field.cover')}</Text>
        <View style={styles.coverRow}>
          <View style={[styles.coverPreview, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {coverUrl ? (
              <>
                <Image source={{ uri: coverUrl }} style={styles.coverImg} />
                <TouchableOpacity onPress={() => setCoverUrl('')} style={styles.coverRemove} testID="cover-remove">
                  <X color="#fff" size={14} />
                </TouchableOpacity>
              </>
            ) : (
              <ImageIcon color={colors.textSecondary} size={28} />
            )}
          </View>
          <View style={{ flex: 1, gap: 8 }}>
            <TouchableOpacity
              testID="cover-pick-gallery"
              onPress={pickCover}
              style={[styles.smallBtn, { borderColor: colors.border, backgroundColor: colors.surface }]}
            >
              <Text style={[styles.smallBtnLabel, { color: colors.textPrimary }]}>{t('upload.field.cover.gallery')}</Text>
            </TouchableOpacity>
            <TextInput
              testID="cover-url-input"
              value={coverUrl.startsWith('data:') ? '' : coverUrl}
              onChangeText={setCoverUrl}
              placeholder={t('upload.field.cover.url')}
              placeholderTextColor={colors.textSecondary}
              style={[styles.input, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.surface, marginBottom: 0 }]}
              autoCapitalize="none"
            />
          </View>
        </View>

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('upload.field.folder')}</Text>
        <View style={styles.chips}>
          <TouchableOpacity
            testID="folder-chip-none"
            onPress={() => setFolderId(undefined)}
            style={[styles.chip, { borderColor: !folderId ? colors.primaryActive : colors.border, backgroundColor: colors.surface }]}
          >
            <Text style={[styles.chipLabel, { color: !folderId ? colors.primaryActive : colors.textPrimary }]}>{t('upload.field.folder.none')}</Text>
          </TouchableOpacity>
          {folders.map((f) => (
            <TouchableOpacity
              key={f.id}
              testID={`folder-chip-${f.id}`}
              onPress={() => setFolderId(f.id)}
              style={[styles.chip, { borderColor: folderId === f.id ? colors.primaryActive : colors.border, backgroundColor: colors.surface }]}
            >
              <Text style={[styles.chipLabel, { color: folderId === f.id ? colors.primaryActive : colors.textPrimary }]}>{f.name}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity
          testID="upload-submit-btn"
          disabled={!file || busy}
          onPress={submit}
          style={[styles.submit, { backgroundColor: !file || busy ? colors.surface2 : colors.primaryActive }]}
        >
          {busy ? <ActivityIndicator color="#0A0A0C" /> : (
            <>
              <UploadIcon color="#0A0A0C" size={18} />
              <Text style={[styles.submitLabel, { color: '#0A0A0C' }]}>{t('upload.submit')}</Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1 },
  // PATCH (beppe-audiobooks v6): title enlarged to match the Library header.
  title: { fontSize: 42, fontWeight: '800', letterSpacing: -0.8 },
  subtitle: { fontSize: 14, marginTop: 4, marginBottom: 24, lineHeight: 20 },
  dropzone: { borderRadius: 24, borderWidth: 1.5, borderStyle: 'dashed', alignItems: 'center', paddingVertical: 28, gap: 8, marginBottom: 24 },
  dropIcon: { width: 64, height: 64, borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  dropTitle: { fontSize: 15, fontWeight: '600', textAlign: 'center', paddingHorizontal: 16 },
  dropMeta: { fontSize: 12, letterSpacing: 0.4 },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 1, marginBottom: 8, marginTop: 8 },
  input: { height: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, fontSize: 15, marginBottom: 16 },
  coverRow: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  coverPreview: { width: 96, height: 144, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  coverImg: { width: '100%', height: '100%' },
  coverRemove: { position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center' },
  smallBtn: { height: 44, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  smallBtnLabel: { fontSize: 13, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 24 },
  chip: { paddingHorizontal: 14, height: 36, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chipLabel: { fontSize: 13, fontWeight: '600' },
  submit: { flexDirection: 'row', height: 56, borderRadius: 999, alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 8 },
  submitLabel: { fontSize: 15, fontWeight: '700', letterSpacing: 0.3 },
});
