import { readFileSync } from 'node:fs';

interface PackageManifest {
  version: string;
}

/** Version of the runtime package, read once from its package.json. */
export const APP_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as PackageManifest
).version;
