/**
 * Bridge so esbuild bundles the ESM build of @breezystack/lamejs.
 * The package's CJS/IIFE entry exports nothing under require(), so
 * `import * as lamejs from "@breezystack/lamejs"` leaves Mp3Encoder undefined
 * when server.ts is built with --packages=external.
 */
export { Mp3Encoder } from "./node_modules/@breezystack/lamejs/dist/lamejs.js";
