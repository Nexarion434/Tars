import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import { AddressInfo } from 'net';
import { openStream } from '../../../electron/services/machines/client';
import type { PairedMachine } from '../../../electron/services/machines/types';

/**
 * Reading another machine's live output (client.ts, openStream), against a
 * real socket on 127.0.0.1 that plays the other bridge, well or badly. How it
 * can fail, written before the code (security review, 2026-10-08, where it had
 * no test of its own):
 * 1. Chunks come out of order, split, or merged; a chunk holding a line break
 *    or "data:" reads as two; a comment (the bridge's ping) reads as a chunk.
 * 2. A malformed event is passed on, or what follows it is.
 * 3. An answer that is not 200 (refused, no such terminal) yields chunks.
 * 4. onEnd runs twice, or never, whatever ends the stream: the other side,
 *    the connection, or close() here; a chunk reaches onChunk after it.
 * 5. A connection gone silent (a machine that crashed, a dead path) is waited
 *    on forever, so the pane freezes even once the machine is back.
 * 6. An event that never ends is held without bound.
 */

let server: http.Server;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let peer: PairedMachine;

const until = async (what: string, test: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!test()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 10)); }
};

function read(opts?: { idleMs?: number }) {
  const chunks: string[] = [];
  let ends = 0;
  const s = openStream(peer, 'a1', c => chunks.push(c), () => { ends++; }, opts);
  return { chunks, ends: () => ends, close: s.close };
}

const sse = (res: http.ServerResponse) => res.writeHead(200, { 'Content-Type': 'text/event-stream' });
const event = (chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`;

beforeEach(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  peer = { id: 'm-aaaaaaaaaaaaaaaa', name: 'PC', address: '127.0.0.1', port: (server.address() as AddressInfo).port, inboundSecretHash: 'h', outboundSecret: 'their-secret_0123456789abcdefghijklmnopqrs', mayOnMe: 'see', pairedAt: '' };
});
afterEach(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));

describe('a live output from another machine', () => {
  it('1, 4. every chunk in order, line breaks and "data:" kept, pings skipped, then one end', async () => {
    const sent = ['first\r\n', 'data: not an event\n\nstill one chunk', 'é😀'];
    handler = (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${peer.outboundSecret}`);
      sse(res);
      res.write(': ping\n\n');
      // Split across writes, and two events in one: framing is the reader's job.
      const all = sent.map(event).join('');
      res.write(all.slice(0, 7));
      res.end(all.slice(7));
    };
    const r = read();
    await until('ended', () => r.ends() === 1);
    expect(r.chunks).toEqual(sent);
    r.close();
    expect(r.ends()).toBe(1);
  });

  it('2. a malformed event ends the stream, and nothing after it is passed on', async () => {
    handler = (_req, res) => { sse(res); res.write(event('ok') + 'data: {not json\n\n' + event('after')); };
    const r = read();
    await until('ended', () => r.ends() === 1);
    expect(r.chunks).toEqual(['ok']);
  });

  it('2. an event that is not a string ends it too', async () => {
    handler = (_req, res) => { sse(res); res.write('data: {"screen":"x"}\n\n'); };
    const r = read();
    await until('ended', () => r.ends() === 1);
    expect(r.chunks).toEqual([]);
  });

  it('3. an answer that is not 200 gives no chunk and one end', async () => {
    handler = (_req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(event('never')); };
    const r = read();
    await until('ended', () => r.ends() === 1);
    expect(r.chunks).toEqual([]);
  });

  it('4. close() here ends it once, and a chunk sent after never arrives', async () => {
    let response: http.ServerResponse | undefined;
    handler = (_req, res) => { sse(res); res.write(event('one')); response = res; };
    const r = read();
    await until('first chunk', () => r.chunks.length === 1);
    r.close();
    r.close();
    response!.write(event('late'));
    await new Promise(res => setTimeout(res, 50));
    expect(r.chunks).toEqual(['one']);
    expect(r.ends()).toBe(1);
  });

  it('5. a connection silent past its limit is ended', async () => {
    handler = (_req, res) => { sse(res); res.write(event('then nothing')); };
    const r = read({ idleMs: 150 });
    await until('ended by silence', () => r.ends() === 1, 2_000);
    expect(r.chunks).toEqual(['then nothing']);
  });

  it('6. an event that never ends is not held past a megabyte', async () => {
    handler = (_req, res) => { sse(res); res.write(`data: "${'x'.repeat(1024 * 1024 + 10)}`); };
    const r = read();
    await until('ended', () => r.ends() === 1);
    expect(r.chunks).toEqual([]);
  });
});
