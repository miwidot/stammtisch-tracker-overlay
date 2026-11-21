import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from './process.js';

export interface LocalHttps {
  baseUrl: string;
  caFile: string;
  close(): Promise<void>;
}

/**
 * Serves a fixed set of files over HTTPS on a loopback port with a throwaway self-signed
 * certificate. The tracker refuses non-HTTPS overlay URLs, and this keeps the producer reading
 * exactly the overlay bytes this run just built instead of whatever is published somewhere.
 * TLS verification stays on: the certificate is handed to the producer via NODE_EXTRA_CA_CERTS.
 */
export async function serveFilesOverHttps(
  files: Record<string, Buffer>,
  run: Runner
): Promise<LocalHttps> {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-https-'));
  const keyFile = join(dir, 'key.pem');
  const caFile = join(dir, 'cert.pem');
  await run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout',
      keyFile,
      '-out',
      caFile,
    ],
    { label: 'openssl' }
  );
  const routes = new Map(Object.entries(files).map(([name, body]) => [`/${name}`, body]));
  const server: Server = createServer(
    { key: readFileSync(keyFile), cert: readFileSync(caFile) },
    (request, response) => {
      const path = (request.url ?? '').split('?')[0] ?? '';
      const body = request.method === 'GET' || request.method === 'HEAD' ? routes.get(path) : null;
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    }
  );
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTPS server has no port');
  return {
    baseUrl: `https://127.0.0.1:${address.port}`,
    caFile,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolveClose();
        });
      }),
  };
}
