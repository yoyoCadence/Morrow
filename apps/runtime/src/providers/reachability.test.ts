import assert from 'node:assert/strict';
import net, { type AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { checkHost } from './reachability.js';

/*
 * The failure paths against real local sockets. Tests never contact a
 * provider, so the host names are fake and resolve to 127.0.0.1 through an
 * injected lookup.
 */

const toLocalhost = async (): Promise<string> => '127.0.0.1';

async function listen(t: TestContext, onConnection: (socket: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

test('a name that does not resolve is DNS_FAILED, before any connection', async () => {
  const check = await checkHost('nowhere.example', {
    lookup: async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.example'), { code: 'ENOTFOUND' });
    },
  });
  assert.equal(check.result, 'DNS_FAILED');
  assert.equal(check.code, 'ENOTFOUND');
  assert.equal(check.host, 'nowhere.example');
});

test('a port nobody listens on is CONNECT_FAILED', async () => {
  const closed = await new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
  const check = await checkHost('closed.example', { lookup: toLocalhost, port: closed, timeoutMs: 10_000 });
  assert.equal(check.result, 'CONNECT_FAILED');
  assert.equal(check.code, 'ECONNREFUSED');
});

test('a server that accepts the connection and never answers is TIMEOUT', async (t) => {
  const port = await listen(t, () => undefined);
  const check = await checkHost('silent.example', { lookup: toLocalhost, port, timeoutMs: 300 });
  assert.equal(check.result, 'TIMEOUT');
  assert.ok(check.durationMs >= 250 && check.durationMs < 3_000, `gave up after ${check.durationMs} ms, not after the 300 ms asked for`);
});

test('a server that does not speak TLS is TLS_FAILED', async (t) => {
  const port = await listen(t, (socket) => socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'));
  const check = await checkHost('plain.example', { lookup: toLocalhost, port, timeoutMs: 5_000 });
  assert.equal(check.result, 'TLS_FAILED');
  assert.notEqual(check.code, null);
});
