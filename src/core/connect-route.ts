/**
 * CONNECT-target routing for MITM mode. Pure functions, zero sockets — the
 * security-critical host decision lives here so it is unit-testable in
 * isolation (see tests/connect-route.test.ts).
 */

/** Hosts we TLS-terminate + compress. Everything else is raw-tunnelled untouched. */
const MITM_HOSTS = new Set(['api.anthropic.com']);

/** Split an authority-form target ("host:port", "[::1]:443") into host + port. */
export function splitHostPort(authority: string): { host: string; port: number } | null {
  const idx = authority.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = authority.slice(0, idx).replace(/^\[|\]$/g, '').trim().toLowerCase();
  const port = Number(authority.slice(idx + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/**
 * Decide whether a CONNECT target is MITM'd (TLS-terminated + compressed) or
 * raw-tunnelled. EXACT host match only — never substring/includes, or
 * `evil-api.anthropic.com.attacker.com` would be intercepted.
 */
export function routeConnect(host: string): 'mitm' | 'tunnel' {
  const h = host.split(':', 1)[0]!.trim().toLowerCase();
  return MITM_HOSTS.has(h) ? 'mitm' : 'tunnel';
}

/**
 * Parse a full CONNECT request line, e.g. `CONNECT api.anthropic.com:443 HTTP/1.1`.
 * Returns host+port, or null when the line is not a CONNECT (e.g. a plain GET).
 * Used by the byte-sniffing path and the unit tests; the live proxy parses
 * `req.url` (already authority-form) via splitHostPort.
 */
export function parseConnect(firstLine: string): { host: string; port: number } | null {
  const m = /^CONNECT\s+(\S+)\s+HTTP\/\d(?:\.\d)?$/i.exec(firstLine.trim());
  return m ? splitHostPort(m[1]!) : null;
}
