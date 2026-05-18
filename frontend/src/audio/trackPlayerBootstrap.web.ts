// trackPlayerBootstrap.web.ts — Web stub.
//
// react-native-track-player on the web pulls in `shaka-player`, which we
// do NOT bundle. Metro picks this .web.ts file before the native one and
// breaks the chain so the web preview keeps bundling cleanly.
export {};
