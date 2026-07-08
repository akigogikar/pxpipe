import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Real end-to-end: drive the standalone `claude` CLI through the built `pxpipe
// mitm` proxy, exactly as Claude Desktop would be wired. GATED — needs the flag,
// the claude CLI, working credentials, and a built dist/. Off in normal CI.
const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(REPO, 'dist', 'node.js');
const claudeBin = spawnSync('which', ['claude'], { encoding: 'utf8' }).stdout.trim();
const GATED =
  process.env.PXPIPE_E2E === '1' && !!claudeBin && fs.existsSync(claudeBin) && fs.existsSync(DIST);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!GATED)('mitm e2e — real claude CLI through the CONNECT proxy', () => {
  let proxy: ChildProcess;
  let tmpHome: string;
  let eventsFile: string;
  let caPath: string;
  const port = 47990;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-e2e-'));
    eventsFile = path.join(tmpHome, 'events.jsonl');
    caPath = path.join(tmpHome, '.pxpipe', 'mitm', 'ca.crt');
    proxy = spawn(process.execPath, [DIST, 'mitm'], {
      env: { ...process.env, HOME: tmpHome, PORT: String(port), PXPIPE_LOG: eventsFile },
      stdio: 'ignore',
    });
    for (let i = 0; i < 150 && !fs.existsSync(caPath); i++) await sleep(100); // CA appears on start
    await sleep(1000); // let the listener bind
  }, 30_000);

  afterAll(() => {
    proxy?.kill('SIGTERM');
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('routes a Fable request through the proxy and logs a /v1/messages event', () => {
    const res = spawnSync(
      claudeBin,
      ['--model', 'claude-fable-5', '-p', 'reply with the single word: pong'],
      {
        env: {
          ...process.env,
          HTTPS_PROXY: `http://127.0.0.1:${port}`,
          HTTP_PROXY: `http://127.0.0.1:${port}`,
          NODE_EXTRA_CA_CERTS: caPath,
        },
        encoding: 'utf8',
        timeout: 90_000,
      },
    );
    expect(res.status).toBe(0);
    const events = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
    expect(events).toContain('/v1/messages');
  }, 120_000);
});
