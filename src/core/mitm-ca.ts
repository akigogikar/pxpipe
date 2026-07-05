/**
 * Local CA + leaf-cert management for MITM mode. Node's X509Certificate can
 * *parse* but not *mint* certs, so rather than add a cert-minting dependency we
 * shell out to the system `openssl` (present on macOS/Linux; MITM mode is
 * inherently Node/local-only, so this never touches the Workers bundle).
 *
 * Material lives under ~/.pxpipe/mitm/ (dir 0700, private keys 0600). The CA
 * signs exactly one host — api.anthropic.com — so a leak can only impersonate
 * that host to this machine's Node clients.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface CaMaterial {
  caCertPem: string;
  caCertPath: string;
  keyPath: string;
  certPath: string;
}

const MITM_DIR = path.join(os.homedir(), '.pxpipe', 'mitm');
const CA_KEY = path.join(MITM_DIR, 'ca.key');
const CA_CERT = path.join(MITM_DIR, 'ca.crt');
const LEAF_KEY = path.join(MITM_DIR, 'api.anthropic.com.key');
const LEAF_CSR = path.join(MITM_DIR, 'api.anthropic.com.csr');
const LEAF_CRT = path.join(MITM_DIR, 'api.anthropic.com.crt');
const LEAF_EXT = path.join(MITM_DIR, 'api.anthropic.com.ext');

export function mitmDir(): string { return MITM_DIR; }
export function caCertPath(): string { return CA_CERT; }

/** Run openssl with fixed-literal args (never a shell string → no injection). Throws on failure. */
function openssl(args: string[]): void {
  const r = spawnSync('openssl', args, { encoding: 'utf8' });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
    throw new Error(
      'openssl not found on PATH — required to generate the local CA. ' +
        'macOS ships it; on Linux install via `apt install openssl` / `apk add openssl`.',
    );
  }
  if (r.status !== 0) {
    throw new Error(`openssl ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
}

/** True when a system openssl is callable — for a friendly upfront check. */
export function opensslAvailable(): boolean {
  const r = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

/**
 * Idempotent. Creates ~/.pxpipe/mitm/ (0700), a 10-year self-signed root CA, and
 * a leaf for api.anthropic.com signed by it (SAN=DNS:api.anthropic.com). Missing
 * pieces are regenerated; existing ones are left untouched. Returns the paths +
 * CA PEM (for NODE_EXTRA_CA_CERTS wiring and trust instructions).
 */
export function ensureCa(): CaMaterial {
  fs.mkdirSync(MITM_DIR, { recursive: true, mode: 0o700 });

  if (!fs.existsSync(CA_KEY) || !fs.existsSync(CA_CERT)) {
    openssl([
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-days', '3650', '-subj', '/CN=pxpipe MITM CA',
      '-keyout', CA_KEY, '-out', CA_CERT,
    ]);
    fs.chmodSync(CA_KEY, 0o600);
    fs.chmodSync(CA_CERT, 0o600);
  }

  if (!fs.existsSync(LEAF_KEY) || !fs.existsSync(LEAF_CRT)) {
    openssl(['genrsa', '-out', LEAF_KEY, '2048']);
    fs.chmodSync(LEAF_KEY, 0o600);
    openssl(['req', '-new', '-key', LEAF_KEY, '-subj', '/CN=api.anthropic.com', '-out', LEAF_CSR]);
    // SAN must be applied at signing time via -extfile: `x509 -req` drops CSR extensions,
    // and a leaf without a matching SAN is rejected by modern TLS clients.
    fs.writeFileSync(
      LEAF_EXT,
      'subjectAltName=DNS:api.anthropic.com\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n',
      { mode: 0o600 },
    );
    // ponytail: single-host CA. Ceiling: only api.anthropic.com. Upgrade path:
    // take a host param + a per-host leaf cache map when more upstreams are added.
    openssl([
      'x509', '-req', '-in', LEAF_CSR, '-CA', CA_CERT, '-CAkey', CA_KEY,
      '-CAcreateserial', '-sha256', '-days', '825', '-extfile', LEAF_EXT, '-out', LEAF_CRT,
    ]);
    fs.chmodSync(LEAF_CRT, 0o600);
  }

  return {
    caCertPem: fs.readFileSync(CA_CERT, 'utf8'),
    caCertPath: CA_CERT,
    keyPath: LEAF_KEY,
    certPath: LEAF_CRT,
  };
}

/** Leaf key+cert buffers for tls.createSecureContext. Throws if ensureCa hasn't run. */
export function leafSecureContextInput(): { key: Buffer; cert: Buffer } {
  return { key: fs.readFileSync(LEAF_KEY), cert: fs.readFileSync(LEAF_CRT) };
}

/**
 * `mitm doctor` support: returns null when the CA material is present and the
 * private keys are 0600, otherwise a human-readable problem message.
 */
export function checkCa(): string | null {
  for (const f of [CA_KEY, CA_CERT, LEAF_KEY, LEAF_CRT]) {
    if (!fs.existsSync(f)) return `missing ${f} — run \`pxpipe mitm install\``;
  }
  for (const key of [CA_KEY, LEAF_KEY]) {
    const mode = fs.statSync(key).mode & 0o777;
    if (mode & 0o077) return `insecure perms on ${key}: ${mode.toString(8)} (want 600)`;
  }
  return null;
}
