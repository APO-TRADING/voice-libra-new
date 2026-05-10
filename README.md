# Beppe Audiobooks

App mobile (Expo / React Native) per audiolibri con **motore Piper TTS on-device**, completamente offline una volta installata. Zero server.

## Workflow utente in 3 passi

1. Clona il repo, copia i tuoi 2 file nel posto giusto:
   ```
   cp /tuo/percorso/beppe.onnx       frontend/assets/piper/beppe.onnx
   cp /tuo/percorso/beppe.onnx.json  frontend/assets/piper/beppe.onnx.json
   ```
2. Build:
   ```
   cd frontend
   yarn install
   npx expo prebuild --clean
   npx expo run:android        # locale (richiede Android Studio)
   # oppure
   npx eas build --platform android --profile preview
   ```
3. Installa l'APK risultante. Apri l'app, carica un eBook (PDF/EPUB/DOCX/TXT) e tocca play. La voce è quella del tuo `beppe.onnx`, senza connessione.

> Il repo viene già con un Piper italiano (Riccardo) come default. Se non sostituisci i 2 file, l'app parla comunque con quella voce. Sostituendoli, parla con la tua.

## Caratteristiche

- 📚 Libreria con cartelle, copertine custom (URL o galleria), griglia/elenco
- 📤 Upload eBook PDF, EPUB, DOCX, TXT con pulizia testo automatica (porting fedele del tuo `text-converter-cleaner-v5.py`)
- 🎙️ Lettura **Piper on-device** via `react-native-sherpa-onnx-offline-tts` — niente server, niente buffering su disco
- 🔖 Segnalibri intelligenti per frase: l'app riprende dall'inizio della frase interrotta
- ⏯️ Skip ±1/±5/±10 frasi, slider velocità (`length_scale` 0.5×–2.0×), tempo rimanente, evidenziazione frase corrente
- 🌗 Tema chiaro/scuro, persistenza completa al riavvio

## Struttura repository

```
/app
├── backend/                       # FastAPI: solo libreria + upload + pulizia testo
│   ├── server.py
│   ├── text_cleaner.py            # Porting fedele dello script Python originale
│   └── requirements.txt
├── frontend/                      # App React Native (Expo)
│   ├── app/                       # Expo Router (tabs + Player)
│   ├── assets/
│   │   └── piper/                 # ⬇ Modelli Piper PRE-BUNDLATI
│   │       ├── beppe.onnx              ⬅ SOSTITUIRE con il tuo
│   │       ├── beppe.onnx.json         ⬅ SOSTITUIRE con il tuo
│   │       ├── tokens.txt              (universale per IT, lasciare)
│   │       └── espeak-ng-data.zip      (lasciare)
│   ├── metro.config.js            # Estensioni asset .onnx/.zip/.bin abilitate
│   ├── app.json                   # Permessi Android/iOS, background audio
│   └── src/
│       ├── api/client.ts
│       ├── audio/
│       │   ├── piperAssets.ts     # require() di tutti gli asset (NESSUNA EDIT)
│       │   ├── piperEngine.ts     # Init, copia asset, unzip espeak-ng-data, init Sherpa
│       │   └── sherpaPiper.ts     # Guard NativeModules.TTSManager (sicuro in Expo Go)
│       └── contexts/
│           ├── PlayerContext.tsx  # Singleton player, segnalibri, fallback expo-speech
│           └── ThemeContext.tsx
├── scripts/
│   └── text-converter-cleaner-v5.py    # Tuo script originale di riferimento
└── README.md
```

## Architettura runtime

```
[UI Player]
    │  frase corrente
    ▼
[PlayerContext] ─── singleton: stop precedente prima di partire
    │
    ▼ (se modulo nativo presente)
[piperEngine.initEngine] ── al primo avvio:
    ├─ copy beppe.onnx          → docs/piper/
    ├─ copy beppe.onnx.json     → docs/piper/
    ├─ copy tokens.txt          → docs/piper/
    └─ unzip espeak-ng-data.zip → docs/piper/espeak-ng-data/
    │
    ▼ tts.generateAndPlay(text, sid=0, speed=1/length_scale)
[react-native-sherpa-onnx-offline-tts] (modulo nativo)
    │
    ▼ ONNX Runtime + AudioTrack/AVAudioEngine
[beppe.onnx] (inferenza in RAM, niente file audio su disco)
```

- **Real-time**: la frase successiva parte appena la corrente termina (loop sequenziale nel PlayerContext).
- **Singleton**: ogni `play()` chiama `deinitialize()` per fermare istantaneamente la precedente.
- **Background audio predisposto**: `UIBackgroundModes=audio` (iOS) + `FOREGROUND_SERVICE` (Android) attivi in `app.json`.

## Anteprima Expo Go (qui in Emergent)

Il modulo nativo Sherpa NON funziona in Expo Go. In anteprima:
- Tutta l'UI (libreria, cartelle, upload, player, settings) funziona regolarmente.
- L'audio usa `expo-speech` come fallback.
- Piper si attiva SOLO dopo `expo prebuild` + build APK locale o `eas build`.

## Backend (libreria + upload)

Endpoint:
```
GET    /api/books?folder_id=
GET    /api/books/{id}
POST   /api/books/upload         # multipart
PATCH  /api/books/{id}           # title, cover_url, folder_id, length_scale
PATCH  /api/books/{id}/progress
DELETE /api/books/{id}

GET/POST/PATCH/DELETE /api/folders[/{id}]
```

## Cosa NON c'è (limiti dichiarati)

- ❌ **MOBI**: non supportato (libreria Python instabile). Convertilo in EPUB prima.
- ❌ **Controlli da notifica MediaSession**: non implementati. L'audio gira in background ma i pulsanti play/skip nella tendina notifiche richiederebbero un modulo nativo aggiuntivo.

## Licenze

- Piper TTS, sherpa-onnx, espeak-ng-data: licenze rispettive degli upstream
- Modello Italian Riccardo Piper di default: MIT (vedi `assets/piper/MODEL_CARD` se incluso)
