import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// Exercises the raw-tunnel branch of createMitmServer with real localhost
// sockets (no network / no claude). Gated on openssl only, since createMitmServer
// builds a TLS context from the generated leaf even for the tunnel path.
const hasOpenssl = !spawnSync('openssl', ['version']).error;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasOpenssl)('mitm raw tunnel', () => {
  let tmpHome: string;
  let upstream: net.Server;
  let proxy: net.Server;
  let upPort: number;
  let proxyPort: number;
  let open = 0;
  const origHome = process.env.HOME;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-tunnel-'));
    process.env.HOME = tmpHome;
    const { ensureCa } = await import('../src/core/mitm-ca.js');
    ensureCa();
    const { createMitmServer } = await import('../src/core/mitm.js');
    upstream = net.createServer((s) => {
      open++;
      s.on('close', () => open--);
      s.on('error', () => {});
      s.pipe(s); // echo
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upPort = (upstream.address() as net.AddressInfo).port;
    // 127.0.0.1 !== api.anthropic.com → routeConnect() returns 'tunnel'.
    proxy = createMitmServer({ requestHandler: (_req, res) => { res.statusCode = 200; res.end('ok'); } });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    proxyPort = (proxy.address() as net.AddressInfo).port;
  });

  afterAll(() => {
    proxy?.close();
    upstream?.close();
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function connectTunnel(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const c = net.connect(proxyPort, '127.0.0.1', () => {
        c.write(`CONNECT 127.0.0.1:${upPort} HTTP/1.1\r\nHost: 127.0.0.1:${upPort}\r\n\r\n`);
      });
      c.once('data', (d) =>
        d.toString('latin1').startsWith('HTTP/1.1 200') ? resolve(c) : reject(new Error('no 200')),
      );
      c.on('error', reject);
    });
  }

  it('tunnels a non-anthropic host bidirectionally', async () => {
    const c = await connectTunnel();
    const echoed = await new Promise<string>((resolve) => {
      c.once('data', (d) => resolve(d.toString('latin1')));
      c.write('ping');
    });
    expect(echoed).toBe('ping');
    c.destroy();
    await sleep(100);
  });

  it('does not leak the upstream socket when the client RSTs', async () => {
    const base = open;
    const clients = await Promise.all([0, 1, 2, 3, 4].map(() => connectTunnel()));
    await sleep(150);
    expect(open).toBe(base + 5);
    for (const c of clients) c.resetAndDestroy(); // abrupt RST — the leak trigger
    await sleep(400);
    expect(open).toBe(base); // upstreams torn down, no leak
  });
});
