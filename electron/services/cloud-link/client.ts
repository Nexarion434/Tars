import * as http from 'http';
import type { LocalForwardEnd } from '../../platform/local-forward';
import type { HelloResult, LinkClient } from './link';

/**
 * The server's door through the desktop's forward (docs/superpowers/plans/2026-11-03-tars-cloud-m2.md,
 * Tasks 5 and 7): a Unix socket end by its path, a loopback end by its port,
 * always `Host: localhost` (the door refuses any other). `hello` is the one
 * request sent without the credential: the link asks it first and hands the
 * credential on only when the door names the expected server.
 */

const HELLO_MAX = 64 * 1024;
const TIMEOUT_MS = 10_000;
const SERVER_ID = /^[0-9a-f]{16}$/;

function target(end: LocalForwardEnd): http.RequestOptions {
  return end.kind === 'unix' ? { socketPath: end.path } : { host: '127.0.0.1', port: end.port };
}

function getJson(end: LocalForwardEnd, urlPath: string, max: number): Promise<{ status: number; json: unknown } | { status?: undefined; detail: string }> {
  return new Promise(resolve => {
    const req = http.request({ ...target(end), method: 'GET', path: urlPath, headers: { Host: 'localhost' }, timeout: TIMEOUT_MS }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) {
          req.destroy();
          resolve({ detail: 'The door answered more than Tars reads.' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: null });
        }
      });
      res.on('error', err => resolve({ detail: err.message }));
    });
    req.on('timeout', () => req.destroy(new Error('The door did not answer in time.')));
    req.on('error', err => resolve({ detail: err.message }));
    req.end();
  });
}

export function createDoorClient(end: LocalForwardEnd): LinkClient {
  return {
    async hello(): Promise<HelloResult> {
      const answer = await getJson(end, '/cloud/v1/hello', HELLO_MAX);
      if (answer.status === undefined) return { ok: false, detail: answer.detail };
      const serverId = (answer.json as { serverId?: unknown } | null)?.serverId;
      if (answer.status !== 200 || typeof serverId !== 'string' || !SERVER_ID.test(serverId)) {
        return { ok: false, status: answer.status, detail: `The door answered ${answer.status} to hello.` };
      }
      return { ok: true, serverId };
    },
  };
}
