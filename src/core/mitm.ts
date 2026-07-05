/**
 * MITM CONNECT front-end for Claude Desktop, whose embedded claude-code pins
 * ANTHROPIC_BASE_URL and so can't be pointed at the base-URL proxy. Instead the
 * client is aimed at us via HTTPS_PROXY; we terminate TLS for ONLY
 * api.anthropic.com (with our own CA) to compress requests, and raw-tunnel every
 * other host untouched.
 *
 * One http.Server does everything:
 *   - plain HTTP on the port  → its normal request handler (the dashboard)
 *   - CONNECT api.anthropic.com → TLS-terminate, then re-emit the decrypted
 *       socket back onto the SAME server so requests hit the same handler
 *   - CONNECT anything else    → net.connect + raw pipe (no inspection)
 *
 * Node-only (node:net/node:tls/node:http). Imported ONLY from src/node.ts so it
 * never enters the Cloudflare Workers bundle.
 */

import * as net from 'node:net';
import * as tls from 'node:tls';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import { routeConnect, splitHostPort } from './connect-route.js';
import { leafSecureContextInput } from './mitm-ca.js';

export interface MitmDeps {
  /** The (req,res) closure shared with the plain-HTTP server (dashboard routes + handle()). */
  requestHandler: (req: IncomingMessage, res: ServerResponse) => void;
}

/**
 * Build the CONNECT front-end. Does NOT listen — the caller owns lifecycle
 * (server.listen / shutdown), so shutdown handling is identical to plain mode.
 * ensureCa() MUST have run first (leafSecureContextInput reads the leaf files).
 */
export function createMitmServer(deps: MitmDeps): Server {
  const secureContext = tls.createSecureContext(leafSecureContextInput());
  const server = createHttpServer(deps.requestHandler);

  // Surface HTTP parse errors on client sockets instead of crashing the process.
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.on('connect', (req: IncomingMessage, clientSock: net.Socket, head: Buffer) => {
    clientSock.on('error', () => clientSock.destroy());
    const target = splitHostPort(req.url ?? '');
    if (!target) {
      clientSock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    if (routeConnect(target.host) === 'mitm') {
      // Ack CONNECT first — the client won't send its TLS ClientHello until it
      // sees the 200. Replay any bytes read past the CONNECT line (usually none)
      // so the TLS layer sees the full ClientHello.
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) clientSock.unshift(head);
      // Terminate TLS with our leaf cert; force http/1.1 so our HTTP/1.1-only
      // server never has to speak h2 (a modern client would otherwise pick h2).
      const tlsSock = new tls.TLSSocket(clientSock, {
        isServer: true,
        secureContext,
        ALPNProtocols: ['http/1.1'],
      });
      tlsSock.on('error', () => clientSock.destroy());
      // Feed the decrypted socket back into the same server → requests reach the
      // shared handler (Host: api.anthropic.com), forwarded to config.upstream.
      server.emit('connection', tlsSock);
      return;
    }

    // Raw tunnel: everything except api.anthropic.com passes through untouched.
    const upstream = net.connect(target.port, target.host, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSock);
      clientSock.pipe(upstream);
    });
    // Tie the two raw sockets' lifecycles together. .pipe() forwards a clean
    // FIN but NOT errors, so a client RST (ECONNRESET — tab close, network
    // blip, client kill) would otherwise leak the upstream socket forever on
    // this long-running proxy. 'close' fires exactly once per socket (for FIN,
    // error, or destroy), so destroying the peer on close covers every case.
    upstream.on('error', () => upstream.destroy());
    upstream.on('close', () => clientSock.destroy());
    clientSock.on('close', () => upstream.destroy());
  });

  return server;
}
