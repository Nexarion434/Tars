import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * /api/local-file serves only what really lies in the vault's attachments
 * (security, every platform).
 *
 * The one route besides /api/health that takes no token: any page open in a
 * browser on this machine can call it. It compared the SPELLED path with
 * ~/.dorothy/vault/attachments, then streamed whatever that path led to. Every
 * agent can write under ~/.dorothy, so one junction or symlink in the
 * attachments folder served the home, ~/.ssh or ~/.tars-private to anyone who
 * asked, with no token.
 *
 * How it can fail, written before the fix (2026-09-27):
 * 1. A link in the attachments folder to the home serves a file of the home.
 * 2. A link there to ~/.ssh or to ~/.tars-private serves a key or a secret.
 * 3. A real attachment is no longer served: the vault's image previews break.
 */

vi.mock('../../../../electron/services/vault-db', () => ({
  getVaultDb: () => { throw new Error('no database in this test'); },
  ftsSearch: vi.fn(),
}));

import { registerVaultRoutes } from '../../../../electron/services/api-routes/vault-routes';
import { VAULT_DIR, PRIVATE_DIR } from '../../../../electron/constants';
import type { RouteApp, RouteContext, RouteRequest } from '../../../../electron/services/api-routes/types';

const onWindows = process.platform === 'win32';
const home = os.homedir();
const attachments = path.join(VAULT_DIR, 'attachments');
const ssh = path.join(home, '.ssh');
const linkDir = (to: string, at: string) => { if (!fs.existsSync(at)) fs.symlinkSync(to, at, onWindows ? 'junction' : 'dir'); };

let server: http.Server;
let port: number;

beforeEach(async () => {
  expect(VAULT_DIR.startsWith(home), 'the vault is not under the throwaway home').toBe(true);
  fs.mkdirSync(attachments, { recursive: true });
  fs.mkdirSync(ssh, { recursive: true });
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(ssh, 'id_ed25519'), 'the key');
  fs.writeFileSync(path.join(PRIVATE_DIR, 'hermes-webhook-secret'), 'the secret');
  fs.writeFileSync(path.join(home, '.bashrc'), 'the profile');
  fs.writeFileSync(path.join(attachments, 'photo.png'), 'a real attachment');
  linkDir(home, path.join(attachments, 'h'));
  linkDir(ssh, path.join(attachments, 's'));
  linkDir(PRIVATE_DIR, path.join(attachments, 'p'));

  const app: RouteApp = {
    routes: [],
    add(method, pattern, handler) { this.routes.push({ method, pattern, handler }); },
    get(pattern, handler) { this.add('GET', pattern, handler); },
    post(pattern, handler) { this.add('POST', pattern, handler); },
    put(pattern, handler) { this.add('PUT', pattern, handler); },
    delete(pattern, handler) { this.add('DELETE', pattern, handler); },
  };
  registerVaultRoutes(app, {} as RouteContext);
  const route = app.routes.find(r => r.method === 'GET' && r.pattern === '/api/local-file')!;
  // What api-server.ts does around a handler, and nothing more.
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const sendJson = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const routeReq = { method: 'GET', pathname: url.pathname, url, body: {}, raw: req, res, params: {} } as unknown as RouteRequest;
    void route.handler(routeReq, sendJson, {} as RouteContext);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

function get(file: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/api/local-file?path=${encodeURIComponent(file)}` }, res => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

describe('/api/local-file and links in the attachments folder', () => {
  it('1. refuses a file of the home through a link to the home', async () => {
    const out = await get(path.join(attachments, 'h', '.bashrc'));
    expect(out.status).toBe(403);
    expect(out.body).not.toContain('the profile');
  });

  it('2. refuses a key through a link to ~/.ssh, and a secret through a link to ~/.tars-private', async () => {
    for (const file of [path.join(attachments, 's', 'id_ed25519'), path.join(attachments, 'h', '.ssh', 'id_ed25519'), path.join(attachments, 'p', 'hermes-webhook-secret')]) {
      const out = await get(file);
      expect(out.status, file).toBe(403);
      expect(out.body, file).not.toMatch(/the key|the secret/);
    }
  });

  it('3. still serves a real attachment', async () => {
    expect(await get(path.join(attachments, 'photo.png'))).toEqual({ status: 200, body: 'a real attachment' });
  });
});
