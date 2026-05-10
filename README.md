# Beppe Audiobooks

App mobile per audiolibri (Expo / React Native) con motore **Piper TTS on-device**, completamente offline una volta installata.

## Caratteristiche

- 📚 **Libreria** con cartelle, copertine custom (URL o galleria), griglia/elenco
- 📤 **Upload eBook** PDF, EPUB, DOCX, TXT con pulizia testo automatica
- 🎙️ **Lettura Piper on-device** via [`react-native-sherpa-onnx-offline-tts`](https://github.com/kislay99/react-native-sherpa-onnx-offline-tts) — zero server, zero buffering
- 🔖 **Segnalibri intelligenti** per frase: l'app riprende dall'inizio della frase interrotta
- ⏯️ Skip ±1/±5/±10 frasi, slider velocità (`length_scale` 0.5×–2.0×), tempo rimanente, evidenziazione frase corrente
- 🌗 Tema chiaro/scuro, persistenza completa al riavvio

## Struttura repository

```
/app
├── backend/                       # FastAPI: solo libreria + upload + pulizia testo
│   ├── server.py
│   ├── text_cleaner.py            # Porting fedele del tuo script Python
│   └── requirements.txt
├── frontend/                      # App React Native (Expo)
│   ├── app/                       # Expo Router (tabs + Player)
│   ├── assets/
│   │   └── piper/                 # ⬅ QUI METTI beppe.onnx + beppe.onnx.json + tokens.txt + espeak-ng-data/
│   └── src/
│       ├── api/client.ts
│       ├── audio/
│       │   ├── piperAssets.ts     # ⬅ ABILITA QUI il caricamento del modello
│       │   ├── piperEngine.ts     # Inferenza on-device, copia asset, init Sherpa
│       │   └── sherpaPiper.ts     # Wrapper sicuro al modulo nativo
│       └── contexts/
│           ├── PlayerContext.tsx  # Singleton player, pre-buffering, segnalibri
│           └── ThemeContext.tsx
├── scripts/
│   └── text-converter-cleaner-v5.py    # Tuo script originale (riferimento)
└── README.md
```

## Quickstart per buildare l'APK con Piper on-device

### 1. Aggiungi i file modello

```bash
cd frontend/assets/piper/
# Copia qui:
#   beppe.onnx
#   beppe.onnx.json
#   tokens.txt
#   espeak-ng-data/   (cartella)
```

### 2. Abilita il caricamento

Apri `frontend/src/audio/piperAssets.ts` e sostituisci:

```ts
export const PIPER_ASSETS: PiperAssets | null = null;
```

con il blocco di codice commentato sotto, che fa `require()` dei tre file.

### 3. Genera progetti nativi e builda

```bash
cd frontend
yarn install
npx expo prebuild --clean
# Build locale (richiede Android Studio installato)
npx expo run:android
# oppure build cloud
npx eas login
npx eas build --platform android --profile preview
```

L'APK risultante contiene `beppe.onnx` ed esegue Piper interamente sul dispositivo.

## Aggiornare il modello senza ricompilare la logica

Il motore non è hardcoded. Per cambiare voce:

1. Sostituisci `beppe.onnx` (e relativi `tokens.txt`, `espeak-ng-data/`) in `frontend/assets/piper/`.
2. `npx expo prebuild --clean && npx expo run:android` (o nuovo `eas build`).

Il codice TypeScript di `PlayerContext` e `piperEngine` non va toccato.

## Architettura runtime

```
[Player UI]
    │
    ▼ frase corrente
[PlayerContext] ──── singleton stop precedente
    │                    │
    ▼                    ▼
[piperEngine]       [expo-speech]   ◀── fallback (Expo Go preview o asset assenti)
    │
    ▼ generateAndPlay(text, speed=1/length_scale)
[react-native-sherpa-onnx-offline-tts] (modulo nativo)
    │
    ▼ ONNX inference + AudioTrack/AVAudioEngine
[beppe.onnx] (in-RAM, niente file su disco)
```

- **Zero file audio scritti su storage**: la sintesi avviene in memoria nativa.
- **Real-time**: la frase successiva viene sintetizzata appena la corrente termina (loop nel PlayerContext).
- **Singleton**: ogni nuova `play()` invoca `deinitialize()` per fermare istantaneamente la precedente.

## Backend (libreria + upload)

Il backend FastAPI gestisce solo:

- Upload eBook (multipart) → estrazione testo (pdfplumber/PyPDF2/python-docx/ebooklib) → pulizia (porting del tuo script) → split in frasi → MongoDB
- CRUD libri / cartelle / progressi (segnalibri per frase)

Endpoint principali:

```
GET  /api/books?folder_id=
GET  /api/books/{id}
POST /api/books/upload   # multipart
PATCH /api/books/{id}    # title, cover_url, folder_id, length_scale
PATCH /api/books/{id}/progress
DELETE /api/books/{id}

GET/POST/PATCH/DELETE /api/folders[/...]
```

> Il backend NON fa più TTS. Tutto il TTS è on-device.

## Persistenza

- **Libreria, cartelle, progressi**: MongoDB (sopravvive al riavvio).
- **Preferenze UI** (tema, vista, velocità default): AsyncStorage on-device.
- **Modello Piper**: bundle nell'APK + copiato a `${documentDirectory}/piper/` al primo avvio.

## Cosa NON c'è (limiti dichiarati)

- ❌ **MOBI**: non supportato (libreria Python instabile). Convertilo in EPUB prima.
- ❌ **MediaSession / controlli da notifica**: non implementati. L'audio gira in background (UIBackgroundModes audio per iOS, FOREGROUND_SERVICE per Android sono predisposti) ma i pulsanti play/skip nella tendina notifiche richiederebbero un modulo nativo aggiuntivo.
- ⚠️ **Anteprima Expo Go**: il modulo nativo Sherpa NON funziona in Expo Go. Il preview qui usa `expo-speech` come fallback. Piper si attiva solo dopo `expo run:android` o `eas build`.

## Licenze

- Piper TTS: MIT
- sherpa-onnx: Apache 2.0
- Modelli `beppe.onnx`: licenza scelta da te al momento della pubblicazione.
