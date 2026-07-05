import { describe, expect, it } from 'vitest';
import { routeConnect, parseConnect, splitHostPort } from '../src/core/connect-route.js';

describe('routeConnect', () => {
  it('MITMs api.anthropic.com (with/without port, any case)', () => {
    expect(routeConnect('api.anthropic.com')).toBe('mitm');
    expect(routeConnect('api.anthropic.com:443')).toBe('mitm');
    expect(routeConnect('API.ANTHROPIC.COM')).toBe('mitm');
  });
  it('tunnels every other host', () => {
    expect(routeConnect('example.com')).toBe('tunnel');
    expect(routeConnect('api.openai.com')).toBe('tunnel');
    expect(routeConnect('github.com')).toBe('tunnel');
  });
  it('tunnels look-alike hosts — exact match, never substring', () => {
    expect(routeConnect('evil-api.anthropic.com.attacker.com')).toBe('tunnel');
    expect(routeConnect('api.anthropic.com.attacker.com')).toBe('tunnel');
    expect(routeConnect('notapi.anthropic.com')).toBe('tunnel');
  });
});

describe('splitHostPort', () => {
  it('splits host:port', () => {
    expect(splitHostPort('api.anthropic.com:443')).toEqual({ host: 'api.anthropic.com', port: 443 });
  });
  it('handles bracketed IPv6', () => {
    expect(splitHostPort('[::1]:8080')).toEqual({ host: '::1', port: 8080 });
  });
  it('rejects missing/invalid port', () => {
    expect(splitHostPort('api.anthropic.com')).toBeNull();
    expect(splitHostPort('api.anthropic.com:0')).toBeNull();
    expect(splitHostPort('api.anthropic.com:99999')).toBeNull();
    expect(splitHostPort('api.anthropic.com:abc')).toBeNull();
  });
});

describe('parseConnect', () => {
  it('parses a CONNECT request line', () => {
    expect(parseConnect('CONNECT api.anthropic.com:443 HTTP/1.1')).toEqual({
      host: 'api.anthropic.com',
      port: 443,
    });
  });
  it('returns null for non-CONNECT lines', () => {
    expect(parseConnect('GET / HTTP/1.1')).toBeNull();
    expect(parseConnect('POST /v1/messages HTTP/1.1')).toBeNull();
    expect(parseConnect('')).toBeNull();
  });
});
