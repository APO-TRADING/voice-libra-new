import Slider from '@react-native-community/slider';
import { AlertCircle, AlertTriangle, Check, Copy, Cpu, Mic, Moon, Play, Plus, RefreshCw, Sparkles, Sun, Trash2, X, Volume2 } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Clipboard, ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  clearPiperTrace,
  decodePiperError,
  DiagnosticItem,
  getCurrentVoiceId,
  getUseNnapi,
  initEngine,
  isPiperReady,
  listAllVoices,
  listVoices,
  readPiperTrace,
  reloadEngine,
  runFullDiagnostics,
  setCurrentVoiceId,
  setUseNnapi,
  speakSentence,
} from '../../src/audio/piperEngine';
import type { VoiceMeta } from '../../src/audio/piperAssets';
import {
  deleteDynamicVoice,
  importVoice,
  type DynamicVoiceMeta,
} from '../../src/audio/dynamicVoices';
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
  // ----- Voice picker state -----
  const [voices, setVoices] = useState<VoiceMeta[]>(() => listVoices());
  const [dynamicVoiceIds, setDynamicVoiceIds] = useState<Set<string>>(new Set());
  const [activeVoiceId, setActiveVoiceId] = useState<string>(voices[0]?.id ?? 'riccardo');
  const [voiceSwitching, setVoiceSwitching] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  // PATCH (v2.1): NNAPI execution provider opt-in. Re-loaded from
  // AsyncStorage on mount; toggling forces a fresh engine load on next play.
  const [useNnapi, setUseNnapiState] = useState<boolean>(false);
  const [nnapiSwitching, setNnapiSwitching] = useState(false);

  const activeVoiceMeta = voices.find((v) => v.id === activeVoiceId) || null;

  // Refresh the voice catalog (bundled + dynamic). Called on mount and
  // after each import/delete to keep the picker in sync.
  const refreshVoiceCatalog = useCallback(async () => {
    try {
      const all = await listAllVoices();
      const dynIds = new Set<string>();
      for (const v of all) {
        if ((v as Partial<DynamicVoiceMeta>).isDynamic) dynIds.add(v.id);
      }
      setVoices(all);
      setDynamicVoiceIds(dynIds);
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.warn('[Settings] refreshVoiceCatalog failed', e);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try { setActiveVoiceId(await getCurrentVoiceId()); } catch { /* ignore */ }
      try { setUseNnapiState(await getUseNnapi()); } catch { /* ignore */ }
      await refreshVoiceCatalog();
    })();
  }, [refreshVoiceCatalog]);

  const refreshTrace = useCallback(async () => {
    const t = await readPiperTrace();
    setTrace(t || '(vuoto)');
  }, []);

  const switchVoice = useCallback(async (id: string) => {
    if (id === activeVoiceId || voiceSwitching) return;
    setVoiceSwitching(true);
    try {
      await setCurrentVoiceId(id);
      setActiveVoiceId(id);
      // Trigger a background reload so the new voice is ready when the user hits Play.
      await reloadEngine();
    } catch (e: any) {
      Alert.alert('Cambio voce fallito', String(e?.message || e));
    } finally {
      setVoiceSwitching(false);
      refreshTrace();
    }
  }, [activeVoiceId, voiceSwitching, refreshTrace]);

  const testCurrentVoice = useCallback(async () => {
    if (testRunning) return;
    setTestRunning(true);
    try {
      if (!isPiperReady()) {
        const ok = await initEngine();
        if (!ok) {
          Alert.alert('Motore non pronto',
            'Il motore TTS non si è inizializzato. Controlla DIAGNOSTICA PIPER più sotto per i dettagli.');
          return;
        }
      }
      // Demo sentence with the SELECTED voice. Slightly longer than just
      // "Ciao" so cadence and prosody are audible, not only the wake word.
      const phrase = `Ciao, sono ${activeVoiceMeta?.name || 'la voce selezionata'}. Sto leggendo un audiolibro per te.`;
      await speakSentence(phrase, 1.0);
    } catch (e: any) {
      Alert.alert('Test fallito', String(e?.message || e));
    } finally {
      setTestRunning(false);
      refreshTrace();
    }
  }, [testRunning, activeVoiceMeta, refreshTrace]);

  // ───── Import a new voice from device storage ──────────────────────
  const handleImportVoice = useCallback(async () => {
    if (importing) return;
    setImporting(true);
    try {
      const imported = await importVoice();
      if (!imported) return; // user canceled
      await refreshVoiceCatalog();
      Alert.alert(
        t('voice.import.success.title'),
        t('voice.import.success.body', { name: imported.name }),
      );
    } catch (e: any) {
      Alert.alert(
        t('voice.import.failed.title'),
        String(e?.message || e),
      );
    } finally {
      setImporting(false);
      refreshTrace();
    }
  }, [importing, refreshTrace, refreshVoiceCatalog, t]);

  // ───── Delete a dynamic voice ──────────────────────────────────────
  const handleDeleteDynamicVoice = useCallback(async (voice: VoiceMeta) => {
    Alert.alert(
      t('voice.import.delete.confirmTitle'),
      t('voice.import.delete.confirmBody', { name: voice.name, size: voice.size_mb || '?' }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('voice.import.delete.button'),
          style: 'destructive',
          onPress: async () => {
            try {
              // CRITICAL ORDERING: if the user is deleting the currently
              // active voice, we MUST tear down the native engine BEFORE
              // removing the .onnx file. Otherwise Android keeps the file
              // mapped in memory and our deleteAsync silently fails (or
              // worse, the engine keeps reading freed inode blocks).
              const isActive = activeVoiceId === voice.id;
              if (isActive) {
                const bundled = listVoices();
                const fallback = bundled[0]?.id;
                if (!fallback) {
                  // Should never happen since bundled voices ship in the
                  // APK, but defensively bail out so we don't end up with
                  // an undefined active voice.
                  Alert.alert(
                    t('common.error'),
                    'Impossibile eliminare la voce attiva: nessuna voce di sistema disponibile come fallback.',
                  );
                  return;
                }
                await setCurrentVoiceId(fallback);
                setActiveVoiceId(fallback);
                // Force the native module to close its OrtSession + free
                // its handle on the model file. This is async and waits
                // for the new voice to load (best-effort; we still proceed
                // with the delete if reload fails for any reason).
                await reloadEngine().catch(() => {});
              }
              await deleteDynamicVoice(voice.id);
              await refreshVoiceCatalog();
            } catch (e: any) {
              Alert.alert(t('common.error'), String(e?.message || e));
            }
          },
        },
      ],
    );
  }, [t, activeVoiceId, refreshVoiceCatalog]);

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

  // PATCH (v2.1): toggle the NNAPI execution provider. Persists to
  // AsyncStorage and forces a full engine reload so the new option is
  // picked up on the next synth. We re-read the value back from disk
  // after the round-trip so UI state always reflects the source of truth.
  const handleToggleNnapi = useCallback(async (next: boolean) => {
    setNnapiSwitching(true);
    try {
      await setUseNnapi(next);
      setUseNnapiState(next);
      // Best-effort reload; if it fails (e.g. NNAPI unsupported on this
      // device) we silently revert. The engine init log will surface the
      // real reason in the diagnostics screen.
      try {
        await reloadEngine();
      } catch (e: any) {
        Alert.alert(t('common.error'), String(e?.message || e));
        // Roll back the persisted flag so the next play doesn't keep
        // hitting the same NNAPI failure.
        await setUseNnapi(false).catch(() => {});
        setUseNnapiState(false);
      }
      refreshTrace();
    } finally {
      setNnapiSwitching(false);
    }
  }, [refreshTrace, t]);

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

      <Text style={[styles.section, { color: colors.textSecondary }]}>VOCE</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, paddingHorizontal: 12, paddingVertical: 10 }]}>
        <Text style={[styles.rowMeta, { color: colors.textSecondary, paddingHorizontal: 4, marginBottom: 8 }]}>
          {voiceSwitching
            ? 'Cambio voce in corso...'
            : 'Seleziona la voce Piper da usare per la lettura. Le voci aggiuntive si caricano dalla cartella assets/piper/voices/ oppure importandone una nuova.'}
        </Text>

        {/* ── Import dynamic voice button ── */}
        <TouchableOpacity
          testID="import-voice-button"
          onPress={handleImportVoice}
          disabled={importing || voiceSwitching}
          style={[
            styles.importBtn,
            {
              borderColor: colors.primaryActive,
              backgroundColor: colors.primaryActive + '15',
              opacity: (importing || voiceSwitching) ? 0.6 : 1,
            },
          ]}
        >
          {importing ? (
            <ActivityIndicator size="small" color={colors.primaryActive} />
          ) : (
            <Plus color={colors.primaryActive} size={18} />
          )}
          <Text style={[styles.importBtnLabel, { color: colors.primaryActive }]}>
            {importing ? t('voice.import.inProgress') : t('voice.import.button')}
          </Text>
        </TouchableOpacity>
        <Text style={[styles.rowMeta, { color: colors.textSecondary, paddingHorizontal: 4, marginTop: 4, marginBottom: 12, lineHeight: 16 }]}>
          {t('voice.import.hint')}
        </Text>

        {voices.length === 0 ? (
          <View style={{ paddingVertical: 12, alignItems: 'center' }}>
            <AlertCircle color={colors.textSecondary} size={16} />
            <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 6 }}>Nessuna voce trovata</Text>
          </View>
        ) : (
          voices.map((v) => {
            const selected = v.id === activeVoiceId;
            const isDynamic = dynamicVoiceIds.has(v.id);
            return (
              <TouchableOpacity
                key={v.id}
                testID={`voice-${v.id}`}
                onPress={() => switchVoice(v.id)}
                disabled={voiceSwitching}
                style={[
                  styles.voiceRow,
                  {
                    borderColor: selected ? colors.primaryActive : colors.border,
                    backgroundColor: selected ? colors.primaryActive + '15' : colors.background,
                    opacity: voiceSwitching && !selected ? 0.5 : 1,
                  },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ fontSize: 20 }}>{v.flag || '🎤'}</Text>
                    <Text style={{ color: colors.textPrimary, fontSize: 15, fontWeight: '700' }}>
                      {v.name}
                    </Text>
                    {isDynamic && (
                      <View style={[styles.dynamicBadge, { backgroundColor: colors.primaryActive + '30', borderColor: colors.primaryActive }]}>
                        <Text style={[styles.dynamicBadgeText, { color: colors.primaryActive }]}>
                          {t('voice.import.dynamic.badge')}
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 3 }}>
                    {v.language} · {v.quality} · ~{v.size_mb} MB
                  </Text>
                  <Text style={{ color: colors.textSecondary, fontSize: 11, marginTop: 1, lineHeight: 14 }} numberOfLines={2}>
                    {v.description}
                  </Text>
                </View>
                <View style={{ width: isDynamic ? 56 : 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                  {isDynamic && (
                    <TouchableOpacity
                      testID={`voice-delete-${v.id}`}
                      onPress={() => handleDeleteDynamicVoice(v)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      style={styles.voiceDeleteBtn}
                    >
                      <Trash2 color="#ef4444" size={16} />
                    </TouchableOpacity>
                  )}
                  {selected && voiceSwitching ? (
                    <ActivityIndicator size="small" color={colors.primaryActive} />
                  ) : selected ? (
                    <Check color={colors.primaryActive} size={20} />
                  ) : (
                    <Volume2 color={colors.textSecondary} size={18} />
                  )}
                </View>
              </TouchableOpacity>
            );
          })
        )}

        {/* ── Test voce — speak a short Italian sentence with the
              currently selected voice. Stays here in the VOCE section
              (instead of the diagnostics block) so the connection between
              "selected voice" and "test it" is visually obvious. ── */}
        {voices.length > 0 && (
          <TouchableOpacity
            testID="test-voice-button"
            onPress={testCurrentVoice}
            disabled={voiceSwitching || testRunning}
            style={[
              styles.testVoiceBtn,
              {
                backgroundColor: colors.primaryActive,
                opacity: (voiceSwitching || testRunning) ? 0.6 : 1,
              },
            ]}
          >
            {testRunning ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Mic color="#fff" size={16} />
            )}
            <Text style={styles.testVoiceLabel}>
              {testRunning ? 'Sintesi in corso…' : `Prova "${activeVoiceMeta?.name || activeVoiceId}"`}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={[styles.section, { color: colors.textSecondary }]}>{t('settings.tts.section').toUpperCase()}</Text>
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.row}>
          <View style={[styles.iconCircle, { backgroundColor: colors.surface2 }]}>
            {piperReady ? <Check color={colors.primaryActive} size={18} /> : <Cpu color={colors.textSecondary} size={18} />}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: colors.textPrimary }]} testID="tts-status-label">
              {piperReady
                ? t('settings.tts.status.ready')
                : engine === 'unknown'
                  ? t('settings.tts.status.idle')
                  : t('settings.tts.status.error')}
            </Text>
            <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>
              {piperReady
                ? t('settings.tts.status.ready.desc')
                : piperError
                  ? `${t('settings.tts.status.error.prefix')} (${piperStep}): ${piperError}`
                  : engine === 'unknown'
                    ? t('settings.tts.status.idle.desc')
                    : t('settings.tts.status.error.desc')}
            </Text>
          </View>
        </View>
        <View style={[styles.divider, { backgroundColor: colors.border }]} />
        {/* PATCH (v2.1): NNAPI execution provider toggle. */}
        <View style={styles.row}>
          <View style={[styles.iconCircle, { backgroundColor: colors.surface2 }]}>
            <Sparkles color={useNnapi ? colors.primaryActive : colors.textSecondary} size={18} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: colors.textPrimary }]}>
              {t('settings.nnapi.label')}
            </Text>
            <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>
              {t('settings.nnapi.desc')}
            </Text>
          </View>
          <Switch
            testID="nnapi-switch"
            value={useNnapi}
            onValueChange={handleToggleNnapi}
            disabled={nnapiSwitching}
            trackColor={{ true: colors.primaryActive, false: colors.border }}
            thumbColor={colors.surface}
          />
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
            Log persistente del motore TTS. Sopravvive ai crash. Apri qui dopo che l&apos;app si chiude e copia il contenuto.
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
        eBook Speaker · v2.0 · Powered by Piper TTS (Microsoft ONNX Runtime + espeak-ng)
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
  // Voice picker
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1.2,
    marginBottom: 8,
    gap: 12,
  },
  testVoiceBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    height: 48,
    borderRadius: 14,
    marginTop: 8,
  },
  testVoiceLabel: { color: '#fff', fontSize: 15, fontWeight: '700' },
  importBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    height: 48,
    borderRadius: 14,
    borderWidth: 1.5,
    marginBottom: 4,
  },
  importBtnLabel: { fontSize: 15, fontWeight: '700' },
  voiceDeleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dynamicBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  dynamicBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
});
