// All Piper assets are PRE-BUNDLED in the repo. The user replaces ONLY
// beppe.onnx and beppe.onnx.json with their own files.
//
// espeak-ng-data is stored as a renamed zip (.bin) to dodge git/.gitignore
// rules that strip .zip files on some setups.
export const PIPER_ASSETS = {
  model: require('../../assets/piper/beppe.onnx'),
  config: require('../../assets/piper/beppe.onnx.json'),
  tokens: require('../../assets/piper/tokens.txt'),
  espeakZip: require('../../assets/piper/espeak-ng-data.bin'),
} as const;

export type PiperAssetIds = typeof PIPER_ASSETS;
