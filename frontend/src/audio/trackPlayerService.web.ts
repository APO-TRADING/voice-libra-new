// trackPlayerService.web.ts — Web stub.
//
// react-native-track-player on the web pulls in `shaka-player`, which we do
// NOT bundle (it's a 1MB+ video streaming SDK we don't need). Metro picks
// this .web.ts file before the native counterpart and breaks the import
// chain so the web preview keeps bundling cleanly.
async function service(): Promise<void> {
  /* no-op on web */
}

export default service;
