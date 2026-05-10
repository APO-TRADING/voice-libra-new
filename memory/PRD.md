# Beppe Audiobooks — PRD

## App
Mobile-first Expo (React Native) audiobook reader with **on-device Piper TTS** via react-native-sherpa-onnx-offline-tts.

## Stack
- Backend: FastAPI + MongoDB (motor); text extraction (pdfplumber/PyPDF2/python-docx/ebooklib); only library/upload/progress (no TTS).
- Frontend: Expo Router (Libreria, Cartelle, Carica, Impostazioni + /player/[id]); on-device Piper engine via guarded native module; expo-speech fallback for Expo Go preview; AsyncStorage for prefs.

## Architettura TTS
- Modello Piper bundled in `/app/frontend/assets/piper/` (utente aggiunge `beppe.onnx`, `beppe.onnx.json`, `tokens.txt`, `espeak-ng-data/`).
- `src/audio/piperAssets.ts` — single edit point per abilitare bundle (require dei 3 file).
- `src/audio/piperEngine.ts` — Asset.fromModule + FileSystem.copyAsync → tts.initialize(modelDir).
- `src/audio/sherpaPiper.ts` — guard su `NativeModules.TTSManager` (no crash in Expo Go).
- `PlayerContext` — singleton, generationRef per dropping callback stale, loop sequenziale che fa `generateAndPlay` per ogni frase con `speed = 1/length_scale`. Pre-buffering implicito (la chiamata successiva parte appena la corrente termina).

## Endpoint backend
- GET/POST/PATCH/DELETE `/api/folders[/{id}]`
- GET `/api/books?folder_id=`, GET `/api/books/{id}`, POST `/api/books/upload` (multipart), PATCH `/api/books/{id}`, DELETE, PATCH `/api/books/{id}/progress`
- (Rimossi: `/api/tts`, `/api/tts/status`)

## Build per attivare Piper on-device
```
cd /app/frontend
yarn install
# Copia beppe.onnx, beppe.onnx.json, tokens.txt + espeak-ng-data/ in assets/piper/
# Modifica src/audio/piperAssets.ts: PIPER_ASSETS dal blocco commentato
npx expo prebuild --clean
npx expo run:android       # locale con Android Studio
# oppure
npx eas build --platform android --profile preview
```

## Cosa NON c'è
- ❌ MOBI (libreria Python instabile)
- ❌ MediaSession (controlli audio in tendina notifiche) — UIBackgroundModes=audio + FOREGROUND_SERVICE predisposti, ma controlli notifica richiederebbero modulo nativo aggiuntivo
- ⚠️ Anteprima Expo Go: TTS è expo-speech. Piper si attiva SOLO dopo build APK/IPA con prebuild.

## Test status
- Backend pytest 13/13 passing
- Frontend tutte le flow validate via Playwright (Libreria, Cartelle, Carica, Impostazioni, Player)
