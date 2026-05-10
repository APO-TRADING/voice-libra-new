# Modelli Piper — Pre-bundlati

L'app legge tutto **on-device, offline**. Qui ci sono i 3 file pre-bundlati:

| File                    | Cos'è                                            | Va sostituito? |
| ----------------------- | ------------------------------------------------ | :------------: |
| `beppe.onnx`            | Il modello Piper                                 |  ✅ **SÌ**    |
| `beppe.onnx.json`       | Config del modello (sample rate + phoneme map)   |  ✅ **SÌ**    |
| `espeak-ng-data.bin`    | Dati fonemi italiani (espeak-ng zippato)         |     ❌ NO     |

> Da questa versione **non c'è più tokens.txt**: l'app lo auto-genera dal
> `phoneme_id_map` contenuto nel tuo `beppe.onnx.json` al primo avvio.

## Per usare la TUA voce

**Sostituisci 2 file:**
```bash
cp /tuo/percorso/beppe.onnx       frontend/assets/piper/beppe.onnx
cp /tuo/percorso/beppe.onnx.json  frontend/assets/piper/beppe.onnx.json
```

Poi build:
```bash
cd frontend
npx expo prebuild --clean
eas build --platform android --profile preview --clear-cache
```

Fine. Il codice TypeScript non va toccato.

## Cosa fa l'app al primo avvio

1. Copia `beppe.onnx` + `beppe.onnx.json` in `/data/data/.../files/piper/`
2. Legge `beppe.onnx.json`, estrae il `phoneme_id_map` e scrive `tokens.txt` in formato sherpa
3. Unzippa `espeak-ng-data.bin` in `piper/espeak-ng-data/`
4. Inizializza sherpa-onnx con il config completo
5. Da quel momento, la riproduzione è **istantanea e offline**

Se vuoi vedere se Piper si è caricato correttamente: vai in **Impostazioni → MOTORE TTS**. Deve mostrare "Piper on-device attivo". Se mostra un errore, il messaggio dirà esattamente in che step è fallito.
