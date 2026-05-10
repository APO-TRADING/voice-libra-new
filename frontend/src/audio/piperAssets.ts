// Asset Piper pre-bundlati. L'utente sostituisce SOLO:
//   - assets/piper/beppe.onnx       (DEVE essere prodotto da scripts/prepare_piper_model.py)
//   - assets/piper/tokens.txt       (DEVE essere prodotto da scripts/prepare_piper_model.py)
// espeak-ng-data.bin (fonemizzatore italiano) resta invariato.
export const PIPER_ASSETS = {
  model: require('../../assets/piper/beppe.onnx'),
  tokens: require('../../assets/piper/tokens.txt'),
  espeakZip: require('../../assets/piper/espeak-ng-data.bin'),
} as const;

export type PiperAssetIds = typeof PIPER_ASSETS;
