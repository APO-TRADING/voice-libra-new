# Modelli Piper — Pre-bundlati

L'app legge tutto **on-device, offline**. Qui ci sono i 3 file richiesti:

| File                    | Cos'è                                                   | Modifica? |
| ----------------------- | ------------------------------------------------------- | :-------: |
| `beppe.onnx`            | Modello Piper **con metadata sherpa-onnx**             |  ✅ SÌ    |
| `tokens.txt`            | Mappa fonemi → ID, generato dal `.json`                |  ✅ SÌ    |
| `espeak-ng-data.bin`    | Dati fonemizzatore italiano (lascia stare)             |  ❌ NO    |

## ⚠️ IMPORTANTE: il modello DEVE essere preparato

Il `beppe.onnx` originale di Piper **non funziona così com'è** con sherpa-onnx.
Va trasformato: si aggiungono dei metadata interni (model_type=vits, ecc.) e
si genera `tokens.txt` dal `phoneme_id_map` contenuto nel `.json`.

Lo script `scripts/prepare_piper_model.py` fa tutto in automatico.

## Procedura per usare la TUA voce (4 comandi)

```bash
# 1. Metti i tuoi 2 file ORIGINALI in assets/piper/
cp /tuo/percorso/beppe.onnx       frontend/assets/piper/beppe.onnx
cp /tuo/percorso/beppe.onnx.json  frontend/assets/piper/beppe.onnx.json

# 2. Installa la dipendenza Python (una volta)
pip install onnx==1.17.0

# 3. Lancia lo script di preparazione (dalla radice del repo)
python scripts/prepare_piper_model.py
# Aggiunge metadata a beppe.onnx, crea tokens.txt.
# Il file beppe.onnx.json a questo punto è inutile, lo puoi cancellare.

# 4. Build APK
cd frontend
npx expo prebuild --clean
eas build --platform android --profile preview --clear-cache
```

Installa l'APK. Vai in **Impostazioni → MOTORE TTS**:
- ✅ "Piper on-device attivo" → tutto OK, la voce è la tua
- ❌ Errore → mandami il testo del messaggio

## Cosa fa l'app al primo avvio

1. Copia `beppe.onnx` e `tokens.txt` in `/data/data/.../files/piper/`
2. Unzippa `espeak-ng-data.bin` in `piper/espeak-ng-data/`
3. Inizializza sherpa-onnx con i path assoluti
4. Da quel momento la riproduzione è **istantanea e offline**

## Riferimenti

- Procedura ufficiale sherpa-onnx + Piper:
  https://k2-fsa.github.io/sherpa/onnx/tts/piper.html
