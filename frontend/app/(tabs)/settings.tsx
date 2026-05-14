import Slider from '@react-native-community/slider';
import { AlertCircle, AlertTriangle, Check, Copy, Cpu, Mic, Moon, Play, RefreshCw, Sun, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Clipboard, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  clearPiperTrace,
  decodePiperError,
  DiagnosticItem,
  initEngine,
  isPiperReady,
  readPiperTrace,
  runFullDiagnostics,
  speakSentence,
} from '../../src/audio/piperEngine';
import { usePlayer } from '../../src/contexts/PlayerContext';
import { useTheme } from '../../src/contexts/ThemeContext';
import { SUPPORTED_LOCALES, SYSTEM, useI18n, useT } from '../../src/i18n';

export default function SettingsScreen() {
  const { colors, mode, toggleMode, viewMode, setViewMode, defaultLengthScale, setDefaultLengthScale } = useTheme();
  const insets = useSafeAreaInsets();
  const { engine, piperError, piperStep } = usePlayer();
  const t = useT();
  const { storedChoice, setLocale } = useI18n();
  const [trace, setTrace] = useState<string>('(caricamento...)');
  const [diagResults, setDiagResults] = useState<DiagnosticItem[] | null>(null);
  const [diagRunning, setDiagRunning] = useState(false);

  const refreshTrace = useCallback(async () => {
    const t = await readPiperTrace();
    setTrace(t || '(vuoto)');
  }, []);

  useEffect(() => { refreshTrace(); }, [refreshTrace]);

  const copyTrace = () => {
    try {
      (Clipboard as any).setString(trace);
      Alert.alert('Copiato', 'Trace copiato negli appunti. Incollalo nella chat.');
    } catch {
      Alert.alert('Trace', trace);
    }
  };

  const runDiag = useCallback(async () => {
    setDiagRunning(true);
    try {
      const r = await runFullDiagnostics();
      setDiagResults(r);
    } catch (e: any) {
      Alert.alert('Diagnostica errore', String(e?.message || e));
    } finally {
      setDiagRunning(false);
      refreshTrace();
    }
  }, [refreshTrace]);

  const piperReady = engine === 'piper';

  return (
    <ScrollView
      style={[styles.c, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 24, paddingBottom: 96 }}
      testID="settings-screen"
    >
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t('settings.title')}</Text>

      <Text style={[styles.section, { color: colors.textSecondary }]}>{t('settings.section.appearance').toUpperCase()}</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.row}>
          <View style={[styles.iconCircle, { backgroundColor: colors.surface2 }]}>
            {mode === 'dark' ? <Moon color={colors.primaryActive} size={18} /> : <Sun color={colors.primaryActive} size={18} />}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: colors.textPrimary }]}>{t('settings.theme.label')}</Text>
            <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>
              {mode === 'dark' ? t('settings.theme.dark') : t('settings.theme.light')}
            </Text>
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
            <Text style={[styles.rowTitle, { color: colors.textPrimary }]}>{t('settings.viewMode.label')}</Text>
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
                  {v === 'grid' ? t('settings.viewMode.grid') : t('settings.viewMode.list')}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      {/* ──────────────────────────────────────────────────────────────
         Language selector — chooses among 5 supported app locales.
         "Sistema" = follow OS language (auto-detected at each launch).
         ────────────────────────────────────────────────────────────── */}
      <Text style={[styles.section, { color: colors.textSecondary }]}>{t('settings.section.language').toUpperCase()}</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, padding: 12, gap: 8 }]}>
        <View style={styles.langGrid}>
          <TouchableOpacity
            testID="lang-system"
            onPress={() => setLocale(SYSTEM)}
            style={[
              styles.langChip,
              {
                borderColor: storedChoice === SYSTEM ? colors.primaryActive : colors.border,
                backgroundColor: storedChoice === SYSTEM ? colors.primaryActive + '22' : colors.background,
              },
            ]}
          >
            <Text style={[styles.langFlag]}>🌐</Text>
            <Text style={[styles.langSigla, { color: storedChoice === SYSTEM ? colors.primaryActive : colors.textPrimary }]}>
              AUTO
            </Text>
          </TouchableOpacity>

          {SUPPORTED_LOCALES.map((l) => (
            <TouchableOpacity
              key={l.code}
              testID={`lang-${l.code}`}
              onPress={() => setLocale(l.code)}
              style={[
                styles.langChip,
                {
                  borderColor: storedChoice === l.code ? colors.primaryActive : colors.border,
                  backgroundColor: storedChoice === l.code ? colors.primaryActive + '22' : colors.background,
                },
              ]}
            >
              <Text style={styles.langFlag}>{l.flag}</Text>
              <Text style={[styles.langSigla, { color: storedChoice === l.code ? colors.primaryActive : colors.textPrimary }]}>
                {l.sigla}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={[styles.rowMeta, { color: colors.textSecondary, marginTop: 4, paddingHorizontal: 4 }]}>
          {storedChoice === SYSTEM ? t('settings.language.system') : ''}
        </Text>
      </View>

      <Text style={[styles.section, { color: colors.textSecondary }]}>{t('settings.section.playback').toUpperCase()}</Text>
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
              {piperReady ? 'Piper on-device attivo' : engine === 'unknown' ? 'Piper (caricamento al primo play)' : 'TTS dispositivo (fallback)'}
            </Text>
            <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>
              {piperReady
                ? 'Inferenza locale tramite sherpa-onnx + beppe.onnx. Nessun server, nessuna connessione richiesta.'
                : piperError
                  ? `Errore inizializzazione (${piperStep}): ${piperError}`
                  : engine === 'unknown'
                    ? 'Il motore Piper verrà inizializzato al primo Play. La prima inizializzazione può richiedere 10-30 secondi (estrazione fonemi).'
                    : 'TTS dispositivo come fallback.'}
            </Text>
          </View>
        </View>
      </View>

      {/* ── Friendly decoded error card ─────────────────────────────── */}
      {piperError && (() => {
        const decoded = decodePiperError(piperError);
        if (!decoded) return null;
        return (
          <View
            style={[
              styles.card,
              {
                backgroundColor: colors.surface,
                borderColor: '#f59e0b',
                borderWidth: 1.5,
                marginTop: 8,
              },
            ]}
          >
            <View style={{ padding: 14, flexDirection: 'row', gap: 12 }}>
              <View style={{ marginTop: 2 }}>
                <AlertTriangle color="#f59e0b" size={22} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#f59e0b', fontSize: 14, fontWeight: '700', marginBottom: 6 }}>
                  {decoded.title}
                </Text>
                <Text style={{ color: colors.textPrimary, fontSize: 12.5, lineHeight: 18, marginBottom: 8 }}>
                  {decoded.detail}
                </Text>
                <Text style={{ color: colors.textSecondary, fontSize: 11.5, fontStyle: 'italic', lineHeight: 16 }}>
                  💡 {decoded.suggestion}
                </Text>
                <View style={{ marginTop: 8, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  <View style={{ backgroundColor: colors.surface2, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
                    <Text style={{ color: colors.textSecondary, fontSize: 10, fontFamily: 'monospace' }}>
                      categoria: {decoded.category}
                    </Text>
                  </View>
                </View>
              </View>
            </View>
          </View>
        );
      })()}

      <Text style={[styles.section, { color: colors.textSecondary }]}>DIAGNOSTICA PIPER</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={{ paddingVertical: 12 }}>
          <Text style={[styles.rowMeta, { color: colors.textSecondary, marginBottom: 8 }]}>
            Log persistente del motore TTS. Sopravvive ai crash. Apri qui dopo che l'app si chiude e copia il contenuto.
          </Text>

          {/* ─── Verifica integrità file (colored indicators) ─── */}
          <View style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text style={[styles.rowTitle, { color: colors.textPrimary, fontSize: 13 }]}>
                Verifica integrità file
              </Text>
              <TouchableOpacity
                onPress={runDiag}
                disabled={diagRunning}
                style={[styles.toggleBtn, { borderColor: colors.primaryActive, paddingHorizontal: 12, flexDirection: 'row', gap: 6, opacity: diagRunning ? 0.5 : 1 }]}
              >
                <Play color={colors.primaryActive} size={12} />
                <Text style={[styles.toggleLabel, { color: colors.primaryActive, fontSize: 12 }]}>
                  {diagRunning ? 'Verifica…' : 'Verifica'}
                </Text>
              </TouchableOpacity>
            </View>
            {diagResults ? (
              <View style={{ backgroundColor: colors.surface2, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
                {diagResults.map((d, i) => (
                  <View
                    key={i}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      paddingVertical: 6,
                      borderBottomWidth: i < diagResults.length - 1 ? 1 : 0,
                      borderBottomColor: colors.border,
                    }}
                  >
                    <View style={{ width: 20, marginTop: 1, alignItems: 'center' }}>
                      {d.ok ? (
                        <Check color="#22c55e" size={14} />
                      ) : (
                        <X color="#ef4444" size={14} />
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.textPrimary, fontSize: 12, fontWeight: '600' }}>
                        {d.name}
                      </Text>
                      <Text style={{ color: colors.textSecondary, fontSize: 10.5, fontFamily: 'monospace', marginTop: 1 }} selectable>
                        {d.detail}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 6 }}>
                <AlertCircle color={colors.textSecondary} size={12} />
                <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                  Tocca &quot;Verifica&quot; per controllare tutti i file Piper.
                </Text>
              </View>
            )}
          </View>

          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <TouchableOpacity
              onPress={refreshTrace}
              style={[styles.toggleBtn, { borderColor: colors.border, paddingHorizontal: 12, flexDirection: 'row', gap: 6 }]}
            >
              <RefreshCw color={colors.textPrimary} size={14} />
              <Text style={[styles.toggleLabel, { color: colors.textPrimary }]}>Aggiorna</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={copyTrace}
              style={[styles.toggleBtn, { borderColor: colors.border, paddingHorizontal: 12, flexDirection: 'row', gap: 6 }]}
            >
              <Copy color={colors.textPrimary} size={14} />
              <Text style={[styles.toggleLabel, { color: colors.textPrimary }]}>Copia</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={async () => { await clearPiperTrace(); refreshTrace(); }}
              style={[styles.toggleBtn, { borderColor: colors.border, paddingHorizontal: 12 }]}
            >
              <Text style={[styles.toggleLabel, { color: colors.textPrimary }]}>Reset</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={async () => {
                try {
                  if (!isPiperReady()) {
                    Alert.alert('Inizializzazione Piper', 'Attendi 10-30 sec per la prima setup...');
                    await initEngine();
                  }
                  await speakSentence('Ciao.', 1.0);
                  Alert.alert('Test OK', 'La voce ha letto "Ciao" correttamente.');
                } catch (e: any) {
                  Alert.alert('Test fallito', String(e?.message || e));
                } finally {
                  refreshTrace();
                }
              }}
              style={[styles.toggleBtn, { borderColor: colors.primaryActive, paddingHorizontal: 12, flexDirection: 'row', gap: 6 }]}
            >
              <Mic color={colors.primaryActive} size={14} />
              <Text style={[styles.toggleLabel, { color: colors.primaryActive }]}>Test voce</Text>
            </TouchableOpacity>
          </View>
          <Text style={[styles.rowMeta, { color: colors.textSecondary, marginBottom: 6 }]}>
            Trace dettagliato (JS + nativo). Le righe `[native]` e `[audio]` vengono dal Kotlin JNI.
          </Text>
          <ScrollView
            style={{ maxHeight: 360, backgroundColor: colors.surface2, borderRadius: 8, padding: 10 }}
            nestedScrollEnabled
          >
            <Text selectable style={{ color: colors.textPrimary, fontSize: 10.5, fontFamily: 'monospace', lineHeight: 14 }}>
              {trace}
            </Text>
          </ScrollView>
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
  // PATCH (beppe-audiobooks v6): title enlarged to match the Library header.
  title: { fontSize: 42, fontWeight: '800', letterSpacing: -0.8, marginBottom: 8 },
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
  // Language selector
  langGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  langChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    minWidth: 78,
    justifyContent: 'center',
  },
  langFlag: { fontSize: 20 },
  langSigla: { fontSize: 13, fontWeight: '700', letterSpacing: 0.5 },
});
