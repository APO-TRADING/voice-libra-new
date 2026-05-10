# Modelli Piper — Pre-bundlati

Questa cartella contiene **già tutto il necessario** per far parlare l'app.

| File                    | Cos'è                                                            | Va modificato? |
| ----------------------- | ---------------------------------------------------------------- | :------------: |
| `beppe.onnx`            | Modello Piper (voce italiana di default = Riccardo)             |  ✅ **SÌ**    |
| `beppe.onnx.json`       | Config del modello (sample rate, fonemi → ID)                   |  ✅ **SÌ**    |
| `tokens.txt`            | Mappa fonemi/ID per sherpa-onnx                                  |     ❌ NO     |
| `espeak-ng-data.zip`    | Dati espeak-ng (fonemizzatore italiano)                          |     ❌ NO     |

## Per usare la TUA voce

**Sostituisci solo i 2 file marcati ✅:**

```bash
cp /tuo/percorso/beppe.onnx       /app/frontend/assets/piper/beppe.onnx
cp /tuo/percorso/beppe.onnx.json  /app/frontend/assets/piper/beppe.onnx.json
```

Poi build:
```bash
cd /app/frontend
npx expo prebuild --clean
npx expo run:android
# oppure
npx eas build --platform android --profile preview
```

Fine. Il codice TypeScript non va toccato. `tokens.txt` ed `espeak-ng-data.zip`
sono compatibili con qualsiasi voce Piper italiana che usi i fonemi espeak-ng `it`
(cioè tutte le voci italiane standard generate con il training Piper ufficiale).

## Se la tua voce NON è italiana

Sostituisci anche `tokens.txt` ed `espeak-ng-data.zip` con quelli del pacchetto
sherpa-onnx della voce che usi (es. `vits-piper-en_US-ryan-medium`).
Scaricali da https://k2-fsa.github.io/sherpa/onnx/tts/all/.
