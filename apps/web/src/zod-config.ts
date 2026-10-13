import { config } from 'zod';

// The API's CSP (`default-src 'self'`) forbids eval. Unless told not to
// compile, zod tries `new Function` once to see whether it may; the attempt
// is caught, but the browser still reports a CSP violation on every load.
// Parsing gives the same results without compiling, a little slower.
//
// Schemas read this setting when they are created, which is when
// @morrow/core is first imported, so main.tsx imports this module first.
config({ jitless: true });
