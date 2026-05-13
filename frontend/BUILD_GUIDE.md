# Guida passo-passo: dal modello Piper al build APK

> Stato finale: APK installabile su Android con il motore Piper TTS embedded.
> Tempo totale stimato: **40-60 minuti** (di cui ~30 min per il build remoto EAS).

---

## 0. Pre-requisiti (UNA VOLTA SOLA, sul tuo PC)

Apri un terminale (PowerShell su Windows, Terminal su macOS/Linux) e verifica:

```bash
node --version       # serve >= 20.x       (se manca: https://nodejs.org)
yarn --version       # serve >= 1.22       (se manca: npm install -g yarn)
python3 --version    # serve >= 3.9        (se manca: https://python.org)
git --version        # serve >= 2.30
```

Se uno qualsiasi manca, installalo prima di proseguire.

Poi installa i CLI globali Expo + EAS (UNA SOLA VOLTA):

```bash
npm install -g eas-cli
npm install -g expo-cli
```

Verifica:

```bash
eas --version        # serve >= 13.0.0
expo --version       # qualsiasi versione recente va bene
```

---

## 1. Clonare/aggiornare il repository

Se non lo hai ancora clonato:

```bash
git clone <URL-del-tuo-repo>
cd beppe-audiobooks
```

Se ce l'hai già localmente:

```bash
cd beppe-audiobooks
git pull origin main      # o il branch su cui stai lavorando
```

> ⚠️ **IMPORTANTE**: assicurati che la patch dettagliata `frontend/patches/react-native-sherpa-onnx-offline-tts+0.2.6.patch` sia presente (deve avere **640 righe** circa, con `1.12.26` e `xnnpack`).

Verifica:

```bash
wc -l frontend/patches/react-native-sherpa-onnx-offline-tts+0.2.6.patch
grep "1.12.26\|xnnpack\|noiseScale = 0.35" frontend/patches/react-native-sherpa-onnx-offline-tts+0.2.6.patch
```

Devi vedere `640 patches/...` e tre righe (versione, xnnpack, noiseScale).

---

## 2. Mettere il modello Piper nel posto giusto

Copia questi DUE file nella cartella `frontend/assets/piper/`:

```
frontend/assets/piper/
├── beppe.onnx          ← Modello VITS in formato FP32 (NON fp16, NON quantizzato!)
└── beppe.onnx.json     ← Il config Piper standard (JSON piccolo, ~3KB)
```

### ⚠️ CRITICO — Solo modelli FP32 (full precision)

Sherpa-ONNX 1.12.26 (la libreria che usa la nostra app per Piper) supporta **SOLO** modelli in formato:
- ✅ **fp32** (float32 piena precisione) — formato standard di Piper
- ❌ **fp16** (float16 half-precision) → errore `tensor(float16) does not match tensor(float)`
- ❌ **INT8/INT4 quantizzato** → errore `QuantizeLinear`/`tensor(int8)`
- ❌ Modelli con conversione fp16 parziale → stesso errore di fp16

#### Come riconoscere un modello incompatibile

| Dimensione | Producer name | Esito |
|------------|--------------|-------|
| 60-200 MB | `pytorch` | ✅ Probabilmente fp32, OK |
| 30-100 MB | `pytorch` con `--half` | ❌ Fp16, NON funzionerà |
| < 30 MB | `onnx.quantize` o simili | ❌ Quantizzato, NON funzionerà |

#### Se il tuo modello è incompatibile

**Opzione A — Riesporta da Piper training**:
```bash
# NEL pipeline Piper, esporta SENZA conversioni fp16/int8
python -m piper_train.export_onnx \
    --checkpoint <checkpoint.ckpt> \
    --output beppe.onnx
    # NON aggiungere --half / --fp16 / --quantize
```

**Opzione B — Usa un modello "stock" già testato**:
```bash
cd frontend/assets/piper

# Paola medium (~64MB fp32, garantito funzionante)
curl -L -o beppe.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/paola/medium/it_IT-paola-medium.onnx
curl -L -o beppe.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/paola/medium/it_IT-paola-medium.onnx.json

# Riccardo x_low (~28MB fp32, voce maschile più piccola)
# curl -L -o beppe.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx
# curl -L -o beppe.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx.json
```

Verifica:

```bash
ls -lh frontend/assets/piper/beppe.onnx          # FP32: 60-200MB
ls -lh frontend/assets/piper/beppe.onnx.json     # ~2-5KB
```

> 💡 La nostra app **rileva automaticamente** modelli incompatibili nel pannello DIAGNOSTICA PIPER (icona ⚠ "MODELLO QUANTIZZATO" o "Modello in FP16 incompatibile"). Se vedi questo avviso, NON tentare il Test voce — sostituisci il modello prima.

---

## 3. Preparare il modello (iniezione metadata sherpa-onnx)

Lo script Python:

1. Inietta i metadata richiesti da sherpa-onnx **dentro** `beppe.onnx` (in-place)
2. Genera `tokens.txt` dal `phoneme_id_map` del `.json`
3. Genera `piper-config.json` (sample rate, language, voice) che l'app legge a runtime

```bash
# Dalla RADICE del repo (NON dentro frontend/)
pip install onnx==1.17.0
python scripts/prepare_piper_model.py
```

Output atteso:

```text
-> Leggo config da beppe.onnx.json
-> Genero tokens.txt
   130 token scritti
-> Aggiungo metadata a beppe.onnx:
     model_type = vits
     comment = piper
     language = Italian
     voice = it
     has_espeak = 1
     n_speakers = 1
     sample_rate = 22050
-> Scritto piper-config.json: {'sample_rate': 22050, 'language': 'Italian', 'voice': 'it', 'n_speakers': 1}

✓ Fatto! Adesso puoi buildare l'APK:
    cd frontend && npx expo prebuild --clean && eas build ...
```

Verifica i 4 file generati:

```bash
ls -lh frontend/assets/piper/
# beppe.onnx           (con metadata aggiunti)
# beppe.onnx.json      (puoi cancellarlo se vuoi, non serve più all'app)
# espeak-ng-data.bin   (già presente nel repo, ~9MB)
# piper-config.json    (auto-generato, piccolo)
# tokens.txt           (auto-generato, ~800 byte)
```

> ⚠️ Se cambi `beppe.onnx` (per esempio scarichi una versione nuova del modello), DEVI rilanciare lo script Python prima di buildare di nuovo.

---

## 4. Installare le dipendenze JS + applicare la patch nativa

```bash
cd frontend
yarn install
```

Output atteso (le ultime righe):

```text
$ patch-package
patch-package 8.0.1
Applying patches...
react-native-sherpa-onnx-offline-tts@0.2.6 ✔
Done in XX.XXs.
```

> 🔥 **CRITICO**: la riga `react-native-sherpa-onnx-offline-tts@0.2.6 ✔` conferma che la patch v3 (640 righe, JitPack 1.12.26, xnnpack→cpu, log granulari) è stata applicata. Se vedi `✗` o errori, FERMATI e mandami il log.

Verifica manuale:

```bash
grep "sherpa-onnx:1.12.26" node_modules/react-native-sherpa-onnx-offline-tts/android/build.gradle
grep -c "AudioPlayerTrace" node_modules/react-native-sherpa-onnx-offline-tts/android/src/main/java/com/sherpaonnxofflinetts/AudioPlayer.kt
```

Devi vedere la riga `implementation 'com.github.k2-fsa:sherpa-onnx:1.12.26'` e un numero ≥ 25.

---

## 5. Autenticarsi su EAS (UNA VOLTA SOLA)

```bash
eas login
```

Inserisci email e password Expo. Se non hai un account: vai su https://expo.dev/signup, crealo (gratis), poi torna a `eas login`.

Verifica:

```bash
eas whoami
# Deve stampare il tuo username Expo
```

Se è la PRIMA volta che fai un build per questo progetto, configura EAS:

```bash
eas init
```

> Questo crea il `projectId` e lo aggiunge a `app.json`. Se vedi errori del tipo "Project already configured", va bene: skip.

---

## 6. Pre-build nativo

Questo step genera la cartella `android/` con tutto il codice Kotlin (patch inclusa) prima del compile remoto:

```bash
# Sempre dentro frontend/
npx expo prebuild --clean --platform android
```

Output atteso (estratto):

```text
✔ Cleaned native folder
✔ Created native directory
✔ Installed CocoaPods (skip su Windows)
✔ Finished prebuild
```

Tempo: ~1-2 minuti.

> ⚠️ Il flag `--clean` elimina la cartella `android/` esistente e la ricrea da zero. Necessario quando hai cambiato `app.json`, `plugins`, o il modulo nativo patchato.

Verifica veloce che la patch sia nei file generati:

```bash
grep "sherpa-onnx:1.12.26" node_modules/react-native-sherpa-onnx-offline-tts/android/build.gradle
```

Se OK procedi.

---

## 7. Lanciare il build remoto EAS

```bash
# Sempre dentro frontend/
eas build --platform android --profile preview --clear-cache
```

Cosa succede:

1. EAS impacchetta il sorgente (`.tar.gz`) e lo carica sui suoi server
2. Compila il modulo Sherpa-ONNX AAR via JitPack (la PRIMA volta richiede ~5 min extra)
3. Compila l'APK Android (gradle, ~10-20 min)
4. Ti dà un link per scaricare l'APK

Output atteso:

```text
✔ Linked to project @youruser/beppe-audiobooks
✔ Using remote credentials (Expo server)
✔ Compressing project files and uploading to EAS Build...
✔ Build queued
👉 https://expo.dev/accounts/youruser/projects/beppe-audiobooks/builds/<UUID>
```

Apri il link nel browser per vedere il log live.

Tempo totale: **25-40 minuti** (più tempo la prima volta perché JitPack deve buildare l'AAR `1.12.26`).

> 💡 Se vuoi continuare a usare il PC mentre builda, puoi chiudere il terminale: il build continua sui server EAS.

---

## 8. Scaricare e installare l'APK

Quando il build finisce, EAS ti manda una notifica (email + browser) con un pulsante **"Install"**.

**Opzione A (più semplice)**: Apri il link sul tuo Android, tocca "Install", abilita "Install from unknown sources" se richiesto.

**Opzione B (da PC)**: scarica `.apk`, trasferisci sul telefono (USB / Drive / WhatsApp Web), apri il file dal File Manager.

> ⚠️ Se hai già installata una versione precedente di Beppe Audiobooks, **disinstallala prima** (altrimenti potresti avere conflitti di firma).

---

## 9. Primo avvio e diagnostica (NON premere subito "Test voce"!)

1. Apri **Beppe Audiobooks** sul telefono
2. Vai su tab **Impostazioni**
3. Scorri fino a **DIAGNOSTICA PIPER**
4. **PRIMA cosa: tocca "Verifica"** (pulsante con icona ▶ vicino a "Verifica integrità file")

Vedrai 10 indicatori colorati:

| Indicatore | Cosa controlla | Verde ✓ = OK |
|------------|----------------|----------------|
| Platform | iOS/Android | sempre |
| Device | brand, model, RAM | sempre |
| NativeModule | TTSManager Kotlin disponibile | dopo build OK |
| DestDir | `documents/piper/` esiste | dopo primo Test |
| Model | `beppe.onnx` copiato (> 1MB) | dopo primo Test |
| OnnxMagic | primo byte protobuf valido | dopo primo Test |
| Tokens | `tokens.txt` non vuoto | dopo primo Test |
| EspeakDir | `espeak-ng-data/` esiste | dopo primo Test |
| EspeakFiles | ≥ 10 file + phontab + phonindex | dopo primo Test |
| TraceFile | trace log writable | sempre |

> 💡 Al **primissimo** avvio molti saranno ❌ perché i file vengono copiati on-demand al primo Play. È **normale**.

5. **Solo dopo aver verificato il check `NativeModule = ✓`**, tocca **"Test voce"**.
   - Vedrai un alert "Inizializzazione Piper, attendi 10-30 sec..."
   - Aspetta. La prima init scompatta `espeak-ng-data.zip` (3000+ file)
   - Se tutto va bene → senti "Ciao" → "Test OK"

6. **Se invece l'app crasha** → riaprila → Impostazioni → **"Aggiorna"** → **"Copia"** → incollami il log

---

## 10. Cosa fare se qualcosa non funziona

### Caso A: errore durante `prepare_piper_model.py`
- Verifica che `beppe.onnx` E `beppe.onnx.json` siano dentro `frontend/assets/piper/`
- Reinstalla onnx: `pip install --upgrade onnx==1.17.0`

### Caso B: `yarn install` non applica la patch
```bash
cd frontend
rm -rf node_modules
yarn install
```
Se vedi ancora errori, lancia manualmente:
```bash
npx patch-package react-native-sherpa-onnx-offline-tts
```

### Caso C: `eas build` fallisce su JitPack
JitPack a volte impiega del tempo a buildare la prima volta. Rilancia:
```bash
eas build --platform android --profile preview --clear-cache
```

### Caso D: l'APK installa ma crasha subito
- Apri Impostazioni → DIAGNOSTICA PIPER → "Aggiorna" → "Copia"
- Mandami **tutto** il trace (sono ~89 step granulari, vedremo esattamente dove muore)

---

## Riepilogo TL;DR (per quando avrai memorizzato il flusso)

```bash
# Dalla radice del repo:
python scripts/prepare_piper_model.py        # se hai cambiato beppe.onnx

# Dentro frontend/:
cd frontend
yarn install                                  # applica patch v3
npx expo prebuild --clean --platform android
eas build --platform android --profile preview --clear-cache
```

**Tempi**: 1min + 1min + 2min + 25min remoto = **~30 minuti totali**.

---

## Comandi diagnostici utili

```bash
# Quale versione AAR userà il build?
grep "sherpa-onnx:" frontend/node_modules/react-native-sherpa-onnx-offline-tts/android/build.gradle

# Quanti trace native sono attivi?
grep -c "nativeTrace\|AudioPlayerTrace.log" frontend/node_modules/react-native-sherpa-onnx-offline-tts/android/src/main/java/com/sherpaonnxofflinetts/*.kt

# La patch è applicata?
grep "ACCEPTED\|REJECTED\|xnnpack" frontend/node_modules/react-native-sherpa-onnx-offline-tts/android/src/main/java/com/sherpaonnxofflinetts/TTSManagerModule.kt | head -3

# Lista i tuoi build EAS
eas build:list --platform android --limit 5
```

---

_Documento generato per il workflow di build di Beppe Audiobooks v1.0._
