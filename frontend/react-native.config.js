// react-native.config.js — manual autolinking config for our LOCAL native
// module `piper-tts` (vendored in /modules/piper-tts/).
//
// We use manual config instead of letting yarn create a node_modules symlink
// because Expo's metro bundler + autolinking work more reliably when the
// module is declared explicitly here.
const path = require('path');

module.exports = {
  dependencies: {
    'piper-tts': {
      root: path.resolve(__dirname, 'modules/piper-tts'),
      platforms: {
        android: {
          sourceDir: path.resolve(__dirname, 'modules/piper-tts/android'),
          packageImportPath: 'import com.beppeaudiobooks.pipertts.PiperTtsPackage;',
          packageInstance: 'new PiperTtsPackage()',
        },
        ios: null, // iOS support TBD
      },
    },
  },
};
