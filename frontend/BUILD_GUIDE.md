# 📖 Guida completa: dal clone del repo al build APK

> **🆕 PATCH v5 (giugno 2025)** — Fix race condition per la lettura continua di più frasi.
> Se hai già un APK funzionante della v4 ma la lettura si fermava dopo 2 frasi cadendo sul TTS del dispositivo, esegui SOLO questi tre comandi:
>
> ```bash
> git pull
> yarn install
> eas build --platform android --profile preview
> ```
>
> La patch viene applicata automaticamente da `postinstall: patch-package`. Per verificare che il fix sia attivo, dopo aver letto qualche frase apri **Impostazioni → Diagnostica Piper → Trace** e cerca queste righe:
> - `[audio] completion.signal :: reason=drained head=... written=...` (la frase termina correttamente)
> - `[audio] playback.chunk.write :: ... totalFrames=...` (counter cumulativo dei frame scritti)
> - `[native] stopPlayback :: engine preserved` (quando premi pausa, il motore Piper resta caricato)
>
> Se invece compaiono `completion.signal :: reason=deadline`, significa che il dispositivo non aggiorna `getPlaybackHeadPosition()` correttamente — il fix di safety da 5s entra in azione e la riproduzione continua comunque, solo con una piccola troncatura della coda dell'ultimo chunk.

---

# 📖 Guida completa: dal clone del repo al build APK

> Tempo totale stimato: **~45 minuti** (di cui ~25 min di build remoto su server EAS).
> Tutto va eseguito **una volta sola** per i tool — i build successivi richiedono solo gli ultimi 3 comandi.

---

## STEP 1 — Software da installare sul PC (UNA SOLA VOLTA)

Apri un terminale (PowerShell su Windows, Terminal su macOS/Linux) e verifica cosa hai già:

```bash
node --version       # serve >= 20.x
yarn --version       # serve >= 1.22
python --version     # serve >= 3.9  (su Windows usa "python", su macOS/Linux "python3")
git --version        # serve >= 2.30
```

Per ciò che manca:

| Tool | Dove scaricare | Comando alternativo |
|------|----------------|---------------------|
| **Node.js LTS** | https://nodejs.org | — |
| **Yarn** | (dopo Node) | `npm install -g yarn` |
| **Python 3** | https://python.org | — |
| **Git** | https://git-scm.com | — |
| **EAS CLI** | (dopo Node) | `npm install -g eas-cli` |

Verifica i CLI globali:

```bash
eas --version        # serve >= 13.0.0
```

Crea un account Expo gratuito su **https://expo.dev/signup** se non ne hai già uno.

---

## STEP 2 — Cloni il repository in Visual Studio Code

1. Apri **Visual Studio Code**
2. `Ctrl+Shift+P` (Win/Linux) / `Cmd+Shift+P` (macOS) → digita **"Git: Clone"** → Invio
3. Incolla l'URL del repo: `https://github.com/<TU>/beppe-audiobooks.git` (sostituisci con il tuo)
4. Scegli una cartella locale dove clonarlo
5. Quando VS Code chiede "Open repository?" → **Open**
6. Apri il terminale integrato: `Ctrl+ò` (Win/Linux) o `Ctrl+ù`

In alternativa, da terminale:

```bash
cd ~/Documents          # o dove preferisci
git clone https://github.com/<TU>/beppe-audiobooks.git
cd beppe-audiobooks
code .                  # apre VS Code nella cartella appena clonata
```

---

## STEP 3 — Posizioni il modello Piper

Devi mettere **due file** dentro `frontend/assets/piper/`:

```
frontend/assets/piper/
├── beppe.onnx          ← Il tuo modello VITS in formato fp32 (60-200 MB)
└── beppe.onnx.json     ← Il config Piper standard (JSON ~3 KB)
```

> ⚠️ **Importante**: il modello deve essere in **fp32** (formato standard di Piper). La nostra app rileva automaticamente modelli incompatibili e ti avvisa nel pannello Diagnostica.

#### Hai il tuo modello custom?
Mettilo lì, rinomina se necessario.

> 💡 **Modelli "high" (>100 MB) su Android**: Sherpa-ONNX su mobile predilige modelli `low`/`medium` per via dei limiti di memoria nativa. Se hai un modello custom grande che funziona su PC ma crasha su Android, puoi **quantizzarlo a INT8** con lo script GUI incluso:
>
> ```bash
> # Dal tuo PC (richiede onnx + onnxruntime):
> pip install onnx onnxruntime
> python scripts/quantize_to_int8.py
> ```
>
> Si aprirà una GUI tkinter dove:
> 1. Sfogli e selezioni il tuo `beppe.onnx` fp32 originale
> 2. Scegli dove salvare (auto-suggerisce `beppe_int8.onnx`)
> 3. Premi "Avvia quantizzazione"
> 4. Lo script applica PTDQ sicuro per sherpa-onnx (solo MatMul, attivazioni fp32 preservate)
> 5. Valida con `onnx.checker` + smoke test `onnxruntime`
> 6. Ti dice se il modello è compatibile con sherpa-onnx
>
> Risultato: 108 MB → ~30 MB. Qualità praticamente identica. **Funziona dove il fp32 high crasha**.
>
> Modalità CLI alternativa: `python scripts/quantize_to_int8.py beppe.onnx [beppe_int8.onnx]`

#### Non hai un modello? Scarica un Piper italiano "stock":

```bash
cd frontend/assets/piper

# Voce femminile (paola, ~64 MB)
curl -L -o beppe.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/paola/medium/it_IT-paola-medium.onnx
curl -L -o beppe.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/paola/medium/it_IT-paola-medium.onnx.json

# Oppure voce maschile (riccardo, ~28 MB)
# curl -L -o beppe.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx
# curl -L -o beppe.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx.json

cd ../../..
```

Verifica:

```bash
ls -lh frontend/assets/piper/
# Devono comparire:
# beppe.onnx          (60-200 MB se fp32)
# beppe.onnx.json     (~3 KB)
# espeak-ng-data.bin  (~9 MB, già presente nel repo)
```

---

## STEP 4 — Inietta i metadata Sherpa-ONNX nel modello

Lo script Python aggiunge i metadata richiesti da sherpa-onnx **dentro** `beppe.onnx`, e genera automaticamente `tokens.txt` + `piper-config.json`:

```bash
# DALLA RADICE del repo (NON dentro frontend/)
pip install onnx==1.17.0
python scripts/prepare_piper_model.py
```

Output atteso:

```
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
-> Scritto piper-config.json
✓ Fatto!
```

Verifica i 4 file che ora devono esserci in `frontend/assets/piper/`:

```bash
ls -lh frontend/assets/piper/
# beppe.onnx            (con metadata sherpa iniettati)
# beppe.onnx.json       (puoi anche cancellarlo ora, l'app non lo usa)
# espeak-ng-data.bin
# piper-config.json     (auto-generato)
# tokens.txt            (auto-generato)
```

> 💡 Lo script va rilanciato **solo** se cambi `beppe.onnx`. Altrimenti puoi saltare questo step nei build successivi.

---

## STEP 5 — Installa le dipendenze JavaScript

```bash
cd frontend
yarn install
```

Output critico nelle ultime righe:

```
$ patch-package
patch-package 8.0.1
Applying patches...
react-native-sherpa-onnx-offline-tts@0.2.6 ✔
Done in XX.XXs.
```

🔥 **CRITICO**: la riga `react-native-sherpa-onnx-offline-tts@0.2.6 ✔` conferma che la patch nativa (JitPack 1.12.26, Promise async, cpu→xnnpack fallback, log granulari) è stata applicata correttamente. Se vedi `✗` o errori, FERMATI e mandami il log.

Verifica manuale che la patch sia attiva:

```bash
grep "sherpa-onnx:1.12.26" node_modules/react-native-sherpa-onnx-offline-tts/android/build.gradle
grep -c "doInitializeTTS\|promise: Promise" node_modules/react-native-sherpa-onnx-offline-tts/android/src/main/java/com/sherpaonnxofflinetts/TTSManagerModule.kt
```

Devi vedere `implementation 'com.github.k2-fsa:sherpa-onnx:1.12.26'` e un numero ≥ 6.

---

## STEP 6 — Autenticazione EAS (UNA SOLA VOLTA)

```bash
eas login                # inserisci email + password Expo
eas whoami               # verifica
```

Se è la **prima build** di questo progetto, configura il progetto sui server EAS:

```bash
eas init                 # genera il projectId in app.json
```

Se vedi "Project already configured" → ok, salta.

---

## STEP 7 — Pre-build nativo Android

```bash
# Sempre dentro frontend/
npx expo prebuild --clean --platform android
```

⏱️ ~1-2 minuti. Output finale:

```
✔ Cleaned native folder
✔ Created native directory
✔ Finished prebuild
```

> 💡 Il flag `--clean` elimina e ricrea da zero la cartella `android/`. Sempre necessario dopo modifiche a `app.json`, plugins o moduli nativi patchati.

---

## STEP 8 — 🚀 Build remoto EAS

```bash
# Sempre dentro frontend/
eas build --platform android --profile preview --clear-cache
```

Cosa succede:

1. EAS comprime e carica il sorgente sui suoi server
2. La prima volta scarica e compila `sherpa-onnx:1.12.26` via JitPack (~5 min extra)
3. Compila l'APK Android (gradle, ~10-20 min)
4. Ti restituisce un link per scaricare l'APK

Output atteso:

```
✔ Compressing project files and uploading to EAS Build...
✔ Build queued
👉 https://expo.dev/accounts/<TU>/projects/beppe-audiobooks/builds/<UUID>
```

Apri il link nel browser per vedere il log live. Puoi chiudere il terminale: il build continua sui server EAS e ti arriva una notifica email a completamento.

⏱️ **25-40 minuti totali**.

---

## STEP 9 — Installa l'APK sul telefono

Quando il build finisce ricevi un'email Expo con un pulsante **"Install"**.

**Da telefono Android** (più rapido):
1. Apri il link dell'email
2. Tocca "Install"
3. Se richiesto, abilita "Origini sconosciute" / "Installa da fonti esterne"

**Da PC**:
1. Scarica il file `.apk` dalla pagina EAS
2. Trasferiscilo sul telefono (USB / Drive / WhatsApp / Telegram)
3. Aprilo dal File Manager Android → Installa

> ⚠️ Se avevi una versione precedente di "Beppe Audiobooks" installata, **disinstallala prima** per evitare conflitti di firma.

---

## STEP 10 — Primo avvio e test

1. Apri **Beppe Audiobooks** sul telefono
2. Vai sulla tab **Impostazioni**
3. Scorri fino a **DIAGNOSTICA PIPER**
4. **Tocca "Verifica"** (icona ▶ accanto a "Verifica integrità file")
   - Vedrai 11 indicatori colorati ✓/✗
   - Al primissimo avvio alcuni saranno ✗ perché i file non sono ancora stati copiati → **normale**
5. Tocca **"Test voce"**
   - Vedrai un alert "Inizializzazione Piper, attendi 10-30 sec..."
   - La prima inizializzazione:
     - Copia `beppe.onnx` dagli asset al filesystem (~80 ms)
     - Estrae `espeak-ng-data.zip` (~13 sec, 355 file)
     - Carica il modello in memoria nativa (~10-30 sec)
6. Se senti **"Ciao"** → 🎉 **funziona!**

### Se qualcosa non va

Apri **Impostazioni → DIAGNOSTICA PIPER**:

- Se vedi una **card arancione** con un titolo tipo "Modello in FP16 incompatibile" o "Modello QUANTIZZATO incompatibile" → l'app ha rilevato un problema nel modello, segui il suggerimento (di solito serve un modello fp32 standard).
- Altrimenti tocca **"Aggiorna"** → **"Copia"** → incollami il trace nella chat e analizziamo insieme.

---

## 🆘 Troubleshooting rapido

| Problema | Soluzione |
|----------|-----------|
| `prepare_piper_model.py` errore "module onnx not found" | `pip install onnx==1.17.0` |
| `yarn install` non applica patch | `rm -rf node_modules && yarn install` |
| `eas login` chiede 2FA | Usa la password app generata da expo.dev/settings/security |
| EAS build fallisce su JitPack | Rilancia: stesso comando `eas build ...` |
| APK installa ma crasha al primo Play | Manda il trace dalla DIAGNOSTICA PIPER |
| Voce non si sente / modello rifiutato | Vedi la card "ModelFormat" nella DIAGNOSTICA |

---

## ⚡ TL;DR — Comandi per i build successivi (dopo il primo setup)

Una volta che hai il setup iniziale fatto, i build successivi richiedono solo:

```bash
# Dalla radice del repo, SOLO se cambi beppe.onnx:
python scripts/prepare_piper_model.py

# Dentro frontend/:
cd frontend
yarn install                                  # se hai pull-ato modifiche dal repo
npx expo prebuild --clean --platform android
eas build --platform android --profile preview --clear-cache
```

**Tempo totale build successivo**: ~30 minuti (quasi tutto remoto).

---

## 🔍 Comandi di verifica pre-build (utili in caso di problemi)

```bash
# Dentro frontend/

# 1) Quale versione AAR userà il build?
grep "sherpa-onnx:" node_modules/react-native-sherpa-onnx-offline-tts/android/build.gradle

# 2) La patch nativa è applicata? (deve uscire un numero >= 6)
grep -c "doInitializeTTS\|promise: Promise" \
  node_modules/react-native-sherpa-onnx-offline-tts/android/src/main/java/com/sherpaonnxofflinetts/TTSManagerModule.kt

# 3) Provider order corretto? (deve uscire cpu prima di xnnpack)
grep "arrayOf(\"cpu\"" node_modules/react-native-sherpa-onnx-offline-tts/android/src/main/java/com/sherpaonnxofflinetts/TTSManagerModule.kt

# 4) Lista i tuoi build EAS recenti
eas build:list --platform android --limit 5
```

---

_Guida per il workflow di build di Beppe Audiobooks._
