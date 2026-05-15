// Mini player bar shown above the tab bar whenever a book is loaded.
// Persistent across Library / Folders / Upload / Settings tabs so the
// user can play / pause / stop and jump back to the full player
// without losing context.
import { router } from 'expo-router';
import { Pause, Play, Square } from 'lucide-react-native';
import {
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { usePlayer } from '../contexts/PlayerContext';
import { useTheme } from '../contexts/ThemeContext';

// Static fallback covers — same pool used by BookList so a book that
// already has one assigned shows the same image in the mini player.
const FALLBACK_COVERS = [
  'https://images.unsplash.com/photo-1769490315625-6e669d53e698?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjAzMjh8MHwxfHNlYXJjaHwxfHxtaW5pbWFsaXN0JTIwYm9vayUyMGNvdmVyJTIwZGVzaWdufGVufDB8fHx8MTc3ODQyNzM2OHww&ixlib=rb-4.1.0&q=85',
  'https://images.unsplash.com/photo-1768866898428-82a44cddd0e9?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjAzMjh8MHwxfHNlYXJjaHwyfHxtaW5pbWFsaXN0JTIwYm9vayUyMGNvdmVyJTIwZGVzaWdufGVufDB8fHx8MTc3ODQyNzM2OHww&ixlib=rb-4.1.0&q=85',
];

function coverFor(bookId: string, coverUrl: string | null): string {
  if (coverUrl) return coverUrl;
  let h = 0;
  for (let i = 0; i < bookId.length; i++) h = (h * 31 + bookId.charCodeAt(i)) >>> 0;
  return FALLBACK_COVERS[h % FALLBACK_COVERS.length];
}

export default function MiniPlayer() {
  const { colors } = useTheme();
  const { bookId, title, author, coverUrl, isPlaying, sentences, index, toggle, stop } = usePlayer();

  if (!bookId) return null;

  const percent =
    sentences.length > 0 ? Math.min(100, Math.round((index / sentences.length) * 100)) : 0;

  return (
    <View
      pointerEvents="box-none"
      style={styles.wrap}
      testID="mini-player"
    >
      <TouchableOpacity
        activeOpacity={0.92}
        // Tap on the body opens the full player; the play/pause/stop
        // buttons stop propagation so taps on them don't also navigate.
        onPress={() => router.push(`/player/${bookId}`)}
        style={[
          styles.bar,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Image source={{ uri: coverFor(bookId, coverUrl) }} style={styles.cover} />
        <View style={{ flex: 1, paddingHorizontal: 10, gap: 2 }}>
          <Text numberOfLines={1} style={[styles.title, { color: colors.textPrimary }]}>
            {title || '—'}
          </Text>
          {author ? (
            <Text numberOfLines={1} style={[styles.author, { color: colors.textSecondary }]}>
              {author}
            </Text>
          ) : null}
          <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
            <View
              style={[
                styles.progressFill,
                { backgroundColor: colors.primaryActive, width: `${percent}%` },
              ]}
            />
          </View>
        </View>

        <TouchableOpacity
          testID="mini-player-toggle"
          onPress={(e) => {
            e.stopPropagation();
            toggle();
          }}
          style={[styles.btn, { backgroundColor: colors.primaryActive }]}
          hitSlop={6}
        >
          {isPlaying ? (
            <Pause color="#0A0A0C" size={18} fill="#0A0A0C" />
          ) : (
            <Play color="#0A0A0C" size={18} fill="#0A0A0C" />
          )}
        </TouchableOpacity>

        <TouchableOpacity
          testID="mini-player-stop"
          onPress={(e) => {
            e.stopPropagation();
            stop();
          }}
          style={[styles.btnGhost, { borderColor: colors.border }]}
          hitSlop={6}
        >
          <Square color={colors.textPrimary} size={16} fill={colors.textPrimary} />
        </TouchableOpacity>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  // The outer wrapper has no background so the rounded floating pill
  // visually "hovers" over the screen content.
  wrap: {
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 4,
    // soft shadow so it stands out over the list
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 8,
    elevation: 6,
  },
  cover: { width: 44, height: 44, borderRadius: 8 },
  title: { fontSize: 13, fontWeight: '700' },
  author: { fontSize: 11, fontStyle: 'italic' },
  progressTrack: { height: 2, borderRadius: 999, marginTop: 2, overflow: 'hidden' },
  progressFill: { height: '100%' },
  btn: {
    width: 40,
    height: 40,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnGhost: {
    width: 36,
    height: 36,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
});
