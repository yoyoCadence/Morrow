import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRoute, type Route, routePath } from './route.js';

test('paths map to pages, and anything unknown is the system page', () => {
  assert.deepEqual(parseRoute('/', ''), { page: 'system' });
  assert.deepEqual(parseRoute('/evidence', ''), { page: 'evidence', subject: null });
  assert.deepEqual(parseRoute('/evidence/', '?subject='), { page: 'evidence', subject: null }, 'an empty subject is no subject');
  assert.deepEqual(parseRoute('/evidence/observations/42', ''), { page: 'observation', id: '42' });
  for (const unknown of ['/nope', '/evidence/observations/0', '/evidence/observations/abc', '/evidence/observations/1/x']) {
    assert.deepEqual(parseRoute(unknown, ''), { page: 'system' }, unknown);
  }
});

test('every page has a path that leads back to it', () => {
  const subject = 'solana:mainnet-beta:So11111111111111111111111111111111111111112';
  const routes: Route[] = [
    { page: 'system' },
    { page: 'evidence', subject: null },
    { page: 'evidence', subject },
    { page: 'observation', id: '9223372036854775807' },
  ];
  for (const route of routes) {
    const path = routePath(route);
    const [pathname = '', search = ''] = path.split(/(?=\?)/);
    assert.deepEqual(parseRoute(pathname, search), route, path);
  }
  assert.equal(routePath({ page: 'evidence', subject: 'a b&c' }), '/evidence?subject=a%20b%26c', 'the subject is encoded');
});
