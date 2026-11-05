import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { missingHookTools, hookToolsSentence, onPath } from '../../../electron/server/hook-tools';

/**
 * The tools a Tars server's Claude agents need for their hooks
 * (hooks/session-start.sh and the others: bash, jq, curl). Measured on the VPS
 * on 2026-11-04: the container had no jq, so every SessionStart posted an
 * empty session_id, was refused (400), and an agent read as still starting
 * for 3 minutes; an orchestrator's delegation was refused meanwhile, and no
 * task's end was ever told. Written before the code. How it fails:
 * 1. a missing tool not named, or one there named
 * 2. nothing a person can act on: no sentence, or one that does not say
 *    what breaks and how to install them
 * 3. a tool found by name alone where it is not an executable file on PATH
 */
describe('the tools the agents\' hooks need on a server', () => {
  it('1. names the missing ones, in order, and none when all are there', () => {
    expect(missingHookTools(t => t !== 'jq')).toEqual(['jq']);
    expect(missingHookTools(() => false)).toEqual(['bash', 'jq', 'curl']);
    expect(missingHookTools(() => true)).toEqual([]);
  });

  it('2. says what breaks and how to install them, or nothing when none is missing', () => {
    expect(hookToolsSentence(['jq'])).toBe('jq is missing on this server: its Claude agents\' hooks cannot tell Tars when a session starts or a task ends, so a delegation waits and is refused. Install it in the image (Debian: apt-get install -y jq).');
    expect(hookToolsSentence(['jq', 'curl'])).toMatch(/^jq and curl are missing on this server: .*apt-get install -y jq curl\)\.$/);
    expect(hookToolsSentence([])).toBeNull();
  });

  it('3. finds a tool only as an executable file in a PATH folder', () => {
    if (process.platform === 'win32') return; // the server runs on Linux; mode bits mean nothing on Windows
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hook-tools-'));
    fs.writeFileSync(path.join(dir, 'jq'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'curl'), 'not executable', { mode: 0o644 });
    fs.mkdirSync(path.join(dir, 'bash'));
    expect(onPath('jq', dir)).toBe(true);
    expect(onPath('curl', dir)).toBe(false);
    expect(onPath('bash', dir)).toBe(false);
  });
});
