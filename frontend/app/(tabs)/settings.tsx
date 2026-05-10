import Slider from '@react-native-community/slider';
import { Check, Cpu, Moon, Sun } from 'lucide-react-native';
import { ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePlayer } from '../../src/contexts/PlayerContext';
import { useTheme } from '../../src/contexts/ThemeContext';

export default function SettingsScreen() {
  const { colors, mode, toggleMode, viewMode, setViewMode, defaultLengthScale, setDefaultLengthScale } = useTheme();
  const insets = useSafeAreaInsets();
  const { engine } = usePlayer();

  const piperReady = engine === 'piper';

  return (
    <ScrollView
      style={[styles.c, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 24, paddingBottom: 96 }}
      testID="settings-screen"
    >
      <Text style={[styles.title, { color: colors.textPrimary }]}>Impostazioni</Text>

      <Text style={[styles.section, { color: colors.textSecondary }]}>ASPETTO</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.row}>
          <View style={[styles.iconCircle, { backgroundColor: colors.surface2 }]}>
            {mode === 'dark' ? <Moon color={colors.primaryActive} size={18} /> : <Sun color={colors.primaryActive} size={18} />}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: colors.textPrimary }]}>Tema scuro</Text>
            <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>{mode === 'dark' ? 'Attivo' : 'Disattivo'}</Text>
          </View>
          <Switch
            testID="theme-switch"
            value={mode === 'dark'}
            onValueChange={toggleMode}
            trackColor={{ true: colors.primaryActive, false: colors.border }}
            thumbColor={colors.surface}
          />
        </View>
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: colors.textPrimary }]}>Visualizzazione libreria</Text>
            <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>Predefinita</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(['grid', 'list'] as const).map((v) => (
              <TouchableOpacity
                key={v}
                testID={`viewmode-${v}`}
                onPress={() => setViewMode(v)}
                style={[styles.toggleBtn, { borderColor: viewMode === v ? colors.primaryActive : colors.border, backgroundColor: viewMode === v ? colors.surface2 : 'transparent' }]}
              >
                <Text style={[styles.toggleLabel, { color: viewMode === v ? colors.primaryActive : colors.textSecondary }]}>
                  {v === 'grid' ? 'Griglia' : 'Elenco'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      <Text style={[styles.section, { color: colors.textSecondary }]}>RIPRODUZIONE</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.rowCol}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={[styles.rowTitle, { color: colors.textPrimary }]}>Velocità predefinita</Text>
            <Text style={[styles.rowTitle, { color: colors.primaryActive }]}>{defaultLengthScale.toFixed(2)}×</Text>
          </View>
          <Text style={[styles.rowMeta, { color: colors.textSecondary, marginTop: 2 }]}>
            length_scale Piper. Più basso = più veloce. Range 0.5×–2.0×.
          </Text>
          <Slider
            testID="default-length-slider"
            minimumValue={0.5}
            maximumValue={2.0}
            step={0.05}
            value={defaultLengthScale}
            onValueChange={setDefaultLengthScale}
            minimumTrackTintColor={colors.primaryActive}
            maximumTrackTintColor={colors.border}
            thumbTintColor={colors.primaryActive}
            style={{ marginTop: 8 }}
          />
        </View>
      </View>

      <Text style={[styles.section, { color: colors.textSecondary }]}>MOTORE TTS</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.row}>
          <View style={[styles.iconCircle, { backgroundColor: colors.surface2 }]}>
            {piperReady ? <Check color={colors.primaryActive} size={18} /> : <Cpu color={colors.textSecondary} size={18} />}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: colors.textPrimary }]} testID="tts-status-label">
              {piperReady ? 'Piper on-device attivo' : 'TTS dispositivo (anteprima Expo Go)'}
            </Text>
            <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>
              {piperReady
                ? 'Inferenza locale tramite sherpa-onnx + beppe.onnx. Nessun server, nessuna connessione richiesta.'
                : 'Aggiungi beppe.onnx, beppe.onnx.json, tokens.txt in frontend/assets/piper/, abilita PIPER_ASSETS in src/audio/piperAssets.ts e fai build con `npx expo run:android`.'}
            </Text>
          </View>
        </View>
      </View>

      <Text style={[styles.footer, { color: colors.textSecondary }]}>
        Beppe Audiobooks · v1.0 · Powered by Piper TTS (sherpa-onnx)
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1 },
  title: { fontSize: 36, fontWeight: '700', letterSpacing: -0.5, marginBottom: 8 },
  section: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, marginTop: 24, marginBottom: 8, paddingHorizontal: 4 },
  card: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  rowCol: { paddingVertical: 14 },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowMeta: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  iconCircle: { width: 40, height: 40, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  divider: { height: 1, marginHorizontal: -16 },
  toggleBtn: { paddingHorizontal: 14, height: 36, borderRadius: 999, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  toggleLabel: { fontSize: 13, fontWeight: '600' },
  footer: { fontSize: 11, textAlign: 'center', marginTop: 32, letterSpacing: 0.5 },
});
