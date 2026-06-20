// No-op stand-in for `elliptic`. toiljs's client build (vite-plugin-node-polyfills)
// polyfills only Buffer/global/process, so the node `crypto` polyfill chain
// (crypto-browserify -> browserify-sign/create-ecdh -> elliptic) is pulled into
// node_modules but never bundled or executed. This stub keeps the unmaintained,
// advisory-flagged `elliptic` out of the dependency tree. Loading is harmless;
// only actually using EC throws (which never happens in toiljs).
'use strict';
function stub() { throw new Error('elliptic is stubbed out in toiljs (unused node crypto polyfill)'); }
class EC { constructor() { stub(); } }
class EdDSA { constructor() { stub(); } }
module.exports = { ec: EC, eddsa: EdDSA, curve: {}, curves: {}, utils: {}, rand: stub };
