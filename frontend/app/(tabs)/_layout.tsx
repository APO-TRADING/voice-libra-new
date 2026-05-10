import { Tabs } from 'expo-router';
import { Book, Folder, Settings, Upload } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/contexts/ThemeContext';

type IconProps = { color: string; size: number };

const LibraryIcon = ({ color, size }: IconProps) => <Book color={color} size={size} />;
const FolderIcon = ({ color, size }: IconProps) => <Folder color={color} size={size} />;
const UploadIcon = ({ color, size }: IconProps) => <Upload color={color} size={size} />;
const SettingsIcon = ({ color, size }: IconProps) => <Settings color={color} size={size} />;

export default function TabsLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primaryActive,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 64 + insets.bottom,
          paddingTop: 8,
          paddingBottom: 8 + insets.bottom,
        },
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.textPrimary,
        headerShadowVisible: false,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Libreria', tabBarIcon: LibraryIcon }} />
      <Tabs.Screen name="folders" options={{ title: 'Cartelle', tabBarIcon: FolderIcon }} />
      <Tabs.Screen name="upload" options={{ title: 'Carica', tabBarIcon: UploadIcon }} />
      <Tabs.Screen name="settings" options={{ title: 'Impostazioni', tabBarIcon: SettingsIcon }} />
    </Tabs>
  );
}
