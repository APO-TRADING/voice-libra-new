# Piper TTS — On-Device Models

Questo è il punto di ingresso per il motore Piper. **L'app usa questi file
direttamente sul dispositivo**, senza alcun server.

## File richiesti

| File                 | Origine                                | Obbligatorio |
| -------------------- | -------------------------------------- | :----------: |
| `beppe.onnx`         | il tuo modello Piper                   |      ✅      |
| `beppe.onnx.json`    | il tuo file di config Piper            |      ✅      |
| `tokens.txt`         | generato da Piper / sherpa-onnx        |      ✅      |
| `espeak-ng-data/`    | cartella fonemi (sherpa-onnx)          |      ✅      |

> Se non hai `tokens.txt` o `espeak-ng-data/` insieme al tuo `beppe.onnx`,
> li puoi prendere da qualsiasi pacchetto modello Piper italiano già pronto
> per sherpa-onnx (es. https://k2-fsa.github.io/sherpa/onnx/tts/all/).
> Sostituisci poi solo i due file `.onnx` e `.onnx.json` con i tuoi.

## Procedura completa (3 passi)

```bash
# 1) Copia i file dentro questa cartella
cp beppe.onnx beppe.onnx.json tokens.txt /app/frontend/assets/piper/
cp -r espeak-ng-data /app/frontend/assets/piper/

# 2) Abilita il caricamento: apri src/audio/piperAssets.ts
#    e sostituisci `export const PIPER_ASSETS = null;`
#    con il blocco `export const PIPER_ASSETS = { ... }` (commentato sotto).

# 3) Genera progetti nativi e installa
cd /app/frontend
npx expo prebuild --clean
npx expo run:android        # su computer con Android Studio
# oppure
npx eas build --platform android --profile preview
```

L'APK conterrà `beppe.onnx` e tutto il resto. Al primo avvio l'app copia
i file nella cartella documents dell'app e inizializza Piper. Da quel
momento la lettura è **istantanea, real-time, completamente offline**.
