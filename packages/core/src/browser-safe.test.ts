import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The dashboard bundles @morrow/core's main entry. A Node module reachable
 * from it is stubbed out by the bundler and fails only when called, in the
 * browser. These tests walk the compiled import graph, which is what the
 * bundler sees.
 */

const DIST = path.dirname(fileURLToPath(import.meta.url));
const BUILTINS = new Set(builtinModules);
const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every Node built-in the module graph from `entry` imports, with the file that imports it. */
function nodeImports(entry: string): Array<{ readonly module: string; readonly from: string }> {
  const found: Array<{ module: string; from: string }> = [];
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? '';
      if (specifier.startsWith('.')) visit(path.resolve(path.dirname(file), specifier));
      else if (specifier.startsWith('node:') || BUILTINS.has(specifier.split('/')[0] ?? '')) {
        found.push({ module: specifier, from: path.relative(DIST, file) });
      }
    }
  };
  visit(path.join(DIST, entry));
  return found;
}

test('nothing the dashboard imports from @morrow/core needs Node.js', () => {
  assert.deepEqual(nodeImports('index.js'), []);
});

test('the Node-only entry is where node:crypto is, so the walk above can see it', () => {
  assert.ok(
    nodeImports('node.js').some((found) => found.module === 'node:crypto'),
    'if this fails, the walk no longer finds imports and the test above proves nothing',
  );
});
