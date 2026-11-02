import { describe, it, expect } from 'vitest';
import { executeDrive, MAX_KEYS, type DriveTarget } from '../../../electron/services/cloud/drive';

/**
 * Driving a Tars server's agent from a client (plan Task 7, first half: keys
 * and size, which need no sender line). The executor knows nothing of HTTP;
 * it follows the window's own path (agent:input, agent:resize): keys from a
 * desktop are a person at another keyboard.
 *
 * How it fails:
 * - an outside agent (Hermes) typing keys or setting a size: its ceiling
 *   forbids both, whatever its scopes
 * - an unknown agent answered with a sentence naming it
 * - keys empty, not a string, or over 4,096 characters typed
 * - keys typed where no terminal runs (it answers 409, nothing written)
 * - a size outside whole numbers 1 to 1000 applied
 */

function terminals() {
  const typed: string[] = [];
  const sizes: Array<[number, number]> = [];
  const target: DriveTarget = {
    hasAgent: id => id === 'nova' || id === 'asleep',
    typeKeys: (id, data) => { if (id !== 'nova') return 'no-terminal'; typed.push(data); return 'ok'; },
    resize: (id, cols, rows) => { sizes.push([cols, rows]); return id === 'nova' ? 'ok' : 'no-terminal'; },
  };
  return { typed, sizes, target };
}

const desktop = { name: 'Mac', kind: 'desktop' as const };
const hermes = { name: 'Hermes', kind: 'outside-agent' as const };

describe('executeDrive: keys', () => {
  it('types a desktop\'s keys into the terminal', () => {
    const { typed, target } = terminals();
    expect(executeDrive({ action: 'keys', agentId: 'nova', data: 'hello\r' }, desktop, target)).toEqual({ ok: true });
    expect(typed).toEqual(['hello\r']);
  });

  it('refuses an outside agent\'s keys and size, whatever its scopes', () => {
    const { typed, sizes, target } = terminals();
    expect(executeDrive({ action: 'keys', agentId: 'nova', data: 'x' }, hermes, target)).toMatchObject({ ok: false, status: 403 });
    expect(executeDrive({ action: 'size', agentId: 'nova', cols: 80, rows: 24 }, hermes, target)).toMatchObject({ ok: false, status: 403 });
    expect(typed).toEqual([]);
    expect(sizes).toEqual([]);
  });

  it('answers one sentence for an unknown agent, naming none', () => {
    const { target } = terminals();
    const outcome = executeDrive({ action: 'keys', agentId: 'ghost', data: 'x' }, desktop, target);
    expect(outcome).toMatchObject({ ok: false, status: 404 });
    expect(JSON.stringify(outcome)).not.toContain('ghost');
  });

  it.each([
    ['empty keys', ''],
    ['keys over the limit', 'k'.repeat(MAX_KEYS + 1)],
    ['keys that are not a string', 42 as unknown as string],
  ])('refuses %s', (_label, data) => {
    const { typed, target } = terminals();
    expect(executeDrive({ action: 'keys', agentId: 'nova', data }, desktop, target)).toMatchObject({ ok: false, status: 400 });
    expect(typed).toEqual([]);
  });

  it('answers 409 where no terminal runs, and writes nothing', () => {
    const { typed, target } = terminals();
    expect(executeDrive({ action: 'keys', agentId: 'asleep', data: 'x' }, desktop, target)).toMatchObject({ ok: false, status: 409 });
    expect(typed).toEqual([]);
  });
});

describe('executeDrive: size', () => {
  it('sets a whole size from 1 to 1000', () => {
    const { sizes, target } = terminals();
    expect(executeDrive({ action: 'size', agentId: 'nova', cols: 120, rows: 40 }, desktop, target)).toEqual({ ok: true });
    expect(sizes).toEqual([[120, 40]]);
  });

  it.each([[0, 24], [80, 1001], [80.5, 24], [Number.NaN, 24]])('refuses %s x %s', (cols, rows) => {
    const { sizes, target } = terminals();
    expect(executeDrive({ action: 'size', agentId: 'nova', cols, rows }, desktop, target)).toMatchObject({ ok: false, status: 400 });
    expect(sizes).toEqual([]);
  });
});
