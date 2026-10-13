import assert from 'node:assert/strict';
import net, { type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createPool } from './pool.js';

test('a server that accepts the connection but never answers fails within the connection timeout', async (t) => {
  // Accepts TCP and then says nothing, like a peer that vanished mid-connection.
  const sockets: net.Socket[] = [];
  const silent = net.createServer((socket) => void sockets.push(socket));
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    silent.close();
  });
  const { port } = silent.address() as AddressInfo;

  const pool = createPool(`postgres://morrow:unusedPassw0rd@127.0.0.1:${port}/morrow`, {
    applicationName: 'morrow-test',
    connectionTimeoutMs: 300,
  });
  t.after(() => pool.end());

  const started = Date.now();
  await assert.rejects(pool.query('SELECT 1'), /timeout/i);
  assert.ok(Date.now() - started < 3_000, `gave up after ${Date.now() - started} ms`);
});
