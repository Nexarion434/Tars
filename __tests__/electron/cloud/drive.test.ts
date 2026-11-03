import { describe, it, expect } from 'vitest';
import { executeDrive, MAX_KEYS, MAX_DRIVE_TEXT, type DriveTarget } from '../../../electron/services/cloud/drive';
import type { MessageSender } from '../../../electron/core/pty-manager';
import { startsInFlight } from '../../../electron/platform/memory-headroom';

/**
 * Driving a Tars server's agent from a client (plan Task 7). The executor
 * knows nothing of HTTP; it follows the window's own path (agent:input,
 * agent:resize, agent:start, agent:stop): keys from a desktop are a person at
 * another keyboard, and what a client starts, stops or says carries its name.
 *
 * How it fails:
 * - an outside agent (Hermes) typing keys or setting a size: its ceiling
 *   forbids both, whatever its scopes (it may start, stop and message)
 * - an unknown agent answered with a sentence naming it
 * - keys empty, not a string, or over 4,096 characters typed; keys typed where
 *   no terminal runs (409, nothing written)
 * - a size outside whole numbers 1 to 1000 applied
 * - a start that types a first prompt; a failed start reported as done
 * - a stop without a reason, with a reason of controls or format characters
 *   only, or over 200 characters; a stop filed under anything but
 *   "<name> (machine)" or "<name> (outside agent)"
 * - a message empty, of controls and format characters only, or over 8,000
 *   characters typed; one typed where no terminal runs or the CLI has ended;
 *   one typed under any sender but the client's own
 * - (M3 Task 3) a start when the server would be left under its memory floor
 *   reaching the terminal; the refusal without its sentence; the floor not
 *   the one the server set; a server whose memory cannot be read refused
 */

function terminals() {
  const typed: string[] = [];
  const sizes: Array<[number, number]> = [];
  const started: Array<[string, string]> = [];
  const stopped: Array<[string, string, string]> = [];
  const messages: Array<[string, string, MessageSender]> = [];
  const target: DriveTarget = {
    hasAgent: id => ['nova', 'asleep', 'ended', 'broken'].includes(id),
    typeKeys: (id, data) => { if (id !== 'nova') return 'no-terminal'; typed.push(data); return 'ok'; },
    resize: (id, cols, rows) => { sizes.push([cols, rows]); return id === 'nova' ? 'ok' : 'no-terminal'; },
    start: async id => (id === 'broken' ? { ok: false, error: 'The CLI is not installed.' } : (started.push([id, '']), { ok: true })),
    stop: async (id, by, reason) => { stopped.push([id, by, reason]); },
    message: (id, text, sender) => {
      if (id === 'asleep') return 'no-terminal';
      if (id === 'ended') return 'not-running';
      messages.push([id, text, sender]);
      return 'ok';
    },
  };
  return { typed, sizes, started, stopped, messages, target };
}

const desktop = { name: 'Mac', kind: 'desktop' as const };
const hermes = { name: 'Hermes', kind: 'outside-agent' as const };

describe('keys', () => {
  it('types a desktop\'s keys into the terminal', async () => {
    const { typed, target } = terminals();
    expect(await executeDrive({ action: 'keys', agentId: 'nova', data: 'hello\r' }, desktop, target)).toEqual({ ok: true });
    expect(typed).toEqual(['hello\r']);
  });

  it('refuses an outside agent\'s keys and size, whatever its scopes', async () => {
    const { typed, sizes, target } = terminals();
    expect(await executeDrive({ action: 'keys', agentId: 'nova', data: 'x' }, hermes, target)).toMatchObject({ ok: false, status: 403 });
    expect(await executeDrive({ action: 'size', agentId: 'nova', cols: 80, rows: 24 }, hermes, target)).toMatchObject({ ok: false, status: 403 });
    expect(typed).toEqual([]);
    expect(sizes).toEqual([]);
  });

  it('answers one sentence for an unknown agent, naming none', async () => {
    const { target } = terminals();
    for (const request of [
      { action: 'keys' as const, agentId: 'ghost', data: 'x' },
      { action: 'start' as const, agentId: 'ghost' },
      { action: 'stop' as const, agentId: 'ghost', reason: 'done' },
      { action: 'message' as const, agentId: 'ghost', text: 'hi' },
    ]) {
      const outcome = await executeDrive(request, desktop, target);
      expect(outcome).toMatchObject({ ok: false, status: 404 });
      expect(JSON.stringify(outcome)).not.toContain('ghost');
    }
  });

  it.each([
    ['empty keys', ''],
    ['keys over the limit', 'k'.repeat(MAX_KEYS + 1)],
    ['keys that are not a string', 42 as unknown as string],
  ])('refuses %s', async (_label, data) => {
    const { typed, target } = terminals();
    expect(await executeDrive({ action: 'keys', agentId: 'nova', data }, desktop, target)).toMatchObject({ ok: false, status: 400 });
    expect(typed).toEqual([]);
  });

  it('answers 409 where no terminal runs, and writes nothing', async () => {
    const { typed, target } = terminals();
    expect(await executeDrive({ action: 'keys', agentId: 'asleep', data: 'x' }, desktop, target)).toMatchObject({ ok: false, status: 409 });
    expect(typed).toEqual([]);
  });
});

describe('size', () => {
  it('sets a whole size from 1 to 1000', async () => {
    const { sizes, target } = terminals();
    expect(await executeDrive({ action: 'size', agentId: 'nova', cols: 120, rows: 40 }, desktop, target)).toEqual({ ok: true });
    expect(sizes).toEqual([[120, 40]]);
  });

  it.each([[0, 24], [80, 1001], [80.5, 24], [Number.NaN, 24]])('refuses %s x %s', async (cols, rows) => {
    const { sizes, target } = terminals();
    expect(await executeDrive({ action: 'size', agentId: 'nova', cols, rows }, desktop, target)).toMatchObject({ ok: false, status: 400 });
    expect(sizes).toEqual([]);
  });
});

describe('start', () => {
  it('starts with no first prompt, for a desktop and an outside agent', async () => {
    const { started, target } = terminals();
    expect(await executeDrive({ action: 'start', agentId: 'nova' }, desktop, target)).toEqual({ ok: true });
    expect(await executeDrive({ action: 'start', agentId: 'nova' }, hermes, target)).toEqual({ ok: true });
    expect(started).toEqual([['nova', ''], ['nova', '']]);
  });

  it('says why a start failed', async () => {
    const { target } = terminals();
    expect(await executeDrive({ action: 'start', agentId: 'broken' }, desktop, target)).toEqual({ ok: false, status: 409, error: 'The CLI is not installed.' });
  });
});

describe('stop', () => {
  it('files the stop under the client and its kind, with the reason', async () => {
    const { stopped, target } = terminals();
    expect(await executeDrive({ action: 'stop', agentId: 'nova', reason: '  done for today ' }, desktop, target)).toEqual({ ok: true });
    expect(await executeDrive({ action: 'stop', agentId: 'nova', reason: 'night shift over' }, hermes, target)).toEqual({ ok: true });
    expect(stopped).toEqual([['nova', 'Mac (machine)', 'done for today'], ['nova', 'Hermes (outside agent)', 'night shift over']]);
  });

  it.each([
    ['no reason', undefined],
    ['a reason of controls and format characters only', '\u0007\u202E\u200B '],
    ['a reason over 200 characters', 'r'.repeat(201)],
  ])('refuses %s', async (_label, reason) => {
    const { stopped, target } = terminals();
    expect(await executeDrive({ action: 'stop', agentId: 'nova', reason: reason as string }, desktop, target)).toMatchObject({ ok: false, status: 400 });
    expect(stopped).toEqual([]);
  });
});

describe('message', () => {
  it('types the message under the client\'s own sender line', async () => {
    const { messages, target } = terminals();
    expect(await executeDrive({ action: 'message', agentId: 'nova', text: 'run the tests' }, desktop, target)).toEqual({ ok: true });
    expect(await executeDrive({ action: 'message', agentId: 'nova', text: 'stand up' }, hermes, target)).toEqual({ ok: true });
    expect(messages).toEqual([
      ['nova', 'run the tests', { kind: 'machine', name: 'Mac' }],
      ['nova', 'stand up', { kind: 'outside-agent', name: 'Hermes' }],
    ]);
  });

  it.each([
    ['an empty message', ''],
    ['a message of controls and format characters only', '\u0007\u202E \u200B'],
    ['a message over the limit', 'm'.repeat(MAX_DRIVE_TEXT + 1)],
  ])('refuses %s', async (_label, text) => {
    const { messages, target } = terminals();
    expect(await executeDrive({ action: 'message', agentId: 'nova', text }, desktop, target)).toMatchObject({ ok: false, status: 400 });
    expect(messages).toEqual([]);
  });

  it('answers 409 where no terminal runs or the CLI has ended', async () => {
    const { messages, target } = terminals();
    expect(await executeDrive({ action: 'message', agentId: 'asleep', text: 'hi' }, desktop, target)).toMatchObject({ ok: false, status: 409 });
    expect(await executeDrive({ action: 'message', agentId: 'ended', text: 'hi' }, desktop, target)).toMatchObject({ ok: false, status: 409 });
    expect(messages).toEqual([]);
  });
});

describe('the memory floor (M3 Task 3)', () => {
  const withMemory = (availableMb: number | null, floorMb?: number) => {
    const t = terminals();
    t.target.memory = { headroom: () => (availableMb === null ? null : { availableMb, source: 'host' }), floorMb };
    return t;
  };

  it('refuses a start that would leave the server under 1 GB, and starts nothing', async () => {
    const { started, target } = withMemory(900);
    expect(await executeDrive({ action: 'start', agentId: 'nova' }, desktop, target)).toEqual({
      ok: false, status: 503, error: 'Not started: this server has 900 MB of memory free, and Tars keeps 1 GB for the rest of it.',
    });
    expect(started).toEqual([]);
  });

  it('starts with room to spare, at the floor the server set, and when the memory cannot be read', async () => {
    const roomy = withMemory(1400);
    expect(await executeDrive({ action: 'start', agentId: 'nova' }, desktop, roomy.target)).toEqual({ ok: true });
    const higher = withMemory(1400, 2048);
    expect(await executeDrive({ action: 'start', agentId: 'nova' }, desktop, higher.target)).toMatchObject({ ok: false, status: 503 });
    expect(higher.started).toEqual([]);
    const unknown = withMemory(null);
    expect(await executeDrive({ action: 'start', agentId: 'nova' }, desktop, unknown.target)).toEqual({ ok: true });
  });

  // Security review 1, N2, written before the code: starts made together all read the memory before the
  // agents just started have grown, so five within a second all passed the floor.
  it('counts the starts still coming up: the third of three quick starts is refused, and one 30 s later is not', async () => {
    let clock = 0;
    const t = withMemory(1700);
    t.target.memory = { ...t.target.memory!, starting: startsInFlight(30_000, () => clock) };
    expect(await executeDrive({ action: 'start', agentId: 'nova' }, desktop, t.target)).toEqual({ ok: true });
    expect(await executeDrive({ action: 'start', agentId: 'nova' }, desktop, t.target)).toEqual({ ok: true });
    expect(await executeDrive({ action: 'start', agentId: 'nova' }, desktop, t.target)).toMatchObject({ ok: false, status: 503 });
    expect(t.started).toHaveLength(2);
    clock = 30_000;
    expect(await executeDrive({ action: 'start', agentId: 'nova' }, desktop, t.target)).toEqual({ ok: true });
  });
});
