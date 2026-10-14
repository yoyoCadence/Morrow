/*
 * The part of @morrow/core that needs Node.js (node:crypto). Imported as
 * `@morrow/core/node` by the runtime. The dashboard imports only the main
 * entry, which must stay free of Node modules; browser-safe.test.ts checks it.
 */
export * from './contracts/event-identity.js';
