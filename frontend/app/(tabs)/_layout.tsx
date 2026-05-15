import { Tabs } from 'expo-router';
import { Book, Folder, Settings, Upload } from 'lucide-react-native';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MiniPlayer from '../../src/components/MiniPlayer';
import { useTheme } from '../../src/contexts/ThemeContext';
import { useT } from '../../src/i18n';

type IconProps = { color: string; size: number };

const LibraryIcon = ({ color, size }: IconProps) => <Book color={color} size={size} />;
const FolderIcon = ({ color, size }: IconProps) => <Folder color={color} size={size} />;
const UploadIcon = ({ color, size }: IconProps) => <Upload color={color} size={size} />;
const SettingsIcon = ({ color, size }: IconProps) => <Settings color={color} size={size} />;

export default function TabsLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const t = useT();
  const tabBarHeight = 64 + insets.bottom;
  return (
    // PATCH (beppe-audiobooks v6.4): wrap Tabs in a host View so the
    // MiniPlayer can float above the tab bar across every tab screen.
    // pointerEvents="box-none" lets touches inside the screen content
    // pass through, while taps directly on the MiniPlayer hit the bar.
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: colors.primaryActive,
          tabBarInactiveTintColor: colors.textSecondary,
          headerShown: false,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            borderTopWidth: 1,
            height: tabBarHeight,
            paddingTop: 8,
            paddingBottom: 8 + insets.bottom,
          },
          tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
          // Reserve space at the bottom of every tab screen content so
          // the MiniPlayer doesn't cover the last list items.
          sceneStyle: { paddingBottom: 0 },
        }}
      >
        <Tabs.Screen name="index" options={{ title: t('tabs.library'), tabBarIcon: LibraryIcon }} />
        <Tabs.Screen name="folders" options={{ title: t('tabs.folders'), tabBarIcon: FolderIcon }} />
        <Tabs.Screen name="upload" options={{ title: t('tabs.upload'), tabBarIcon: UploadIcon }} />
        <Tabs.Screen name="settings" options={{ title: t('tabs.settings'), tabBarIcon: SettingsIcon }} />
      </Tabs>
      <View
        pointerEvents="box-none"
        style={[styles.miniPlayerHost, { bottom: tabBarHeight }]}
      >
        <MiniPlayer />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  miniPlayerHost: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
});
