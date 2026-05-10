// Asset Piper pre-bundlati. L'utente sostituisce SOLO:
//   - assets/piper/beppe.onnx
//   - assets/piper/beppe.onnx.json
// tokens.txt viene auto-generato a runtime dal phoneme_id_map nel .json.
// espeak-ng-data.bin (fonemizzatore italiano) resta invariato.
export const PIPER_ASSETS = {
  model: require('../../assets/piper/beppe.onnx'),
  config: require('../../assets/piper/beppe.onnx.json'),
  espeakZip: require('../../assets/piper/espeak-ng-data.bin'),
} as const;

export type PiperAssetIds = typeof PIPER_ASSETS;
