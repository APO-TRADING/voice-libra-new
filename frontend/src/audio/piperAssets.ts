// Tutti gli asset Piper sono PRE-BUNDLATI nel repo.
//
// L'utente sostituisce SOLO due file con i propri:
//   /app/frontend/assets/piper/beppe.onnx
//   /app/frontend/assets/piper/beppe.onnx.json
//
// Gli altri due (tokens.txt + espeak-ng-data.zip) restano quelli del pacchetto
// Italian Piper di sherpa-onnx, NON vanno modificati. Funzionano per qualsiasi
// voce Piper italiana che usi gli stessi fonemi espeak-ng (it).
export const PIPER_ASSETS = {
  model: require('../../assets/piper/beppe.onnx'),
  config: require('../../assets/piper/beppe.onnx.json'),
  tokens: require('../../assets/piper/tokens.txt'),
  espeakZip: require('../../assets/piper/espeak-ng-data.zip'),
} as const;

export type PiperAssetIds = typeof PIPER_ASSETS;
