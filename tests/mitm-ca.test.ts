import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const hasOpenssl = !spawnSync('openssl', ['version']).error;

// mitm-ca reads homedir() at module load (MITM_DIR is a module-level const), so
// HOME must be set BEFORE the module is first imported — hence the dynamic import
// inside beforeAll. Vitest isolates modules per test file, so this is clean.
describe.skipIf(!hasOpenssl)('mitm-ca', () => {
  let tmpHome: string;
  let mod: typeof import('../src/core/mitm-ca.js');
  const origHome = process.env.HOME;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-ca-'));
    process.env.HOME = tmpHome;
    mod = await import('../src/core/mitm-ca.js');
  });
  afterAll(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('generates a CA + leaf (SAN=api.anthropic.com), private keys 0600', () => {
    const m = mod.ensureCa();
    for (const f of [m.caCertPath, m.keyPath, m.certPath]) expect(fs.existsSync(f)).toBe(true);
    expect(fs.statSync(m.keyPath).mode & 0o077).toBe(0); // no group/other bits
    const leaf = new X509Certificate(fs.readFileSync(m.certPath));
    expect(leaf.subjectAltName).toContain('DNS:api.anthropic.com');
    const ca = new X509Certificate(m.caCertPem);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(mod.checkCa()).toBeNull();
  });

  it('is idempotent — a second call keeps the same cert', () => {
    const before = fs.readFileSync(mod.caCertPath(), 'utf8');
    mod.ensureCa();
    expect(fs.readFileSync(mod.caCertPath(), 'utf8')).toBe(before);
  });
});
