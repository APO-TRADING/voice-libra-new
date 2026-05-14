import { Tabs } from 'expo-router';
import { Book, Folder, Settings, Upload } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primaryActive,
        tabBarInactiveTintColor: colors.textSecondary,
        // PATCH (beppe-audiobooks v6): hide the navigation header for tabs.
        // Each screen renders its own large title; the small Stack header
        // was duplicated and wasted screen space.
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 64 + insets.bottom,
          paddingTop: 8,
          paddingBottom: 8 + insets.bottom,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('tabs.library'), tabBarIcon: LibraryIcon }} />
      <Tabs.Screen name="folders" options={{ title: t('tabs.folders'), tabBarIcon: FolderIcon }} />
      <Tabs.Screen name="upload" options={{ title: t('tabs.upload'), tabBarIcon: UploadIcon }} />
      <Tabs.Screen name="settings" options={{ title: t('tabs.settings'), tabBarIcon: SettingsIcon }} />
    </Tabs>
  );
}
