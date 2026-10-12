/**
 * The rules a chat's runner is made and scheduled by (ORCHESTRATOR-PER-CHAT.md
 * v2.2, 4.2; PR D of 2.0.0): its name, its worktree and where its branch
 * starts, which runner sleeps to free a slot, which runners a launch after a
 * crash resumes, and the sentence a full limit answers with
 * (electron/core/chat-slots.ts). Pure: the fleet, git and the RAM are read by
 * services/chat-runners.ts and handed in.
 *
 * How it fails, written before the code (2026-10-12):
 * The runner
 * 1. A runner is named like the orchestrator, so a worker cannot tell two
 *    chats apart in its sender line: it must read "<orchestrator> · <title>".
 * 2. Its worktree lands outside the project's .worktrees, or under a name a
 *    chat id can steer (a path, `..`), or two chats share one.
 * 3. Its branch starts from the root's current branch (whatever someone
 *    checked out there) instead of origin's default branch, or from nothing
 *    when there is no remote though a local default branch exists.
 * The slots
 * 4. Main's runner (the persistent orchestrator, which never sleeps) is put to
 *    sleep to free a slot.
 * 5. A runner the sleep rule refuses (in a turn, a message on its way, work
 *    out, a draft) is put to sleep anyway.
 * 6. The most recently active idle runner is chosen rather than the least.
 * 7. A choice is made when nobody may sleep: a slot freed by killing work.
 * After a crash
 * 8. More runners are resumed than the limit leaves slots, or the least
 *    recently active ones first, or a negative count of slots resumes some.
 * The refusal
 * 9. The sentence of a full limit does not say how many, the RAM and the rule,
 *    and who works: the user cannot act on it.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  runnerNameOf, runnerPlaceOf, startPointOf, victimOf, runnersToResume, chatLimitSentence,
} from '../../../electron/core/chat-slots';

describe('a runner', () => {
  it('1. is named after the orchestrator and the chat, so a worker tells chats apart', () => {
    expect(runnerNameOf('Tars-Orchestrator', 'Release 1.9.4')).toBe('Tars-Orchestrator · Release 1.9.4');
    expect(runnerNameOf(undefined, 'Bug #12')).toBe('Orchestrator · Bug #12');
    expect(runnerNameOf('  ', 'Bug #12')).toBe('Orchestrator · Bug #12');
  });

  it("2. works in the project's .worktrees/chat-<8 hex of its id>, on chat/<the same>", () => {
    const project = '/Users/me/projects/demo';
    expect(runnerPlaceOf(project, '4F2A9C11-0b3d-4e5f-8a6b-7c8d9e0f1a2b')).toEqual({
      worktreePath: path.join(project, '.worktrees', 'chat-4f2a9c11'), branchName: 'chat/4f2a9c11',
    });
    // Two chats, two places.
    expect(runnerPlaceOf(project, 'aaaaaaaa-0000-4000-8000-000000000001')?.worktreePath)
      .not.toBe(runnerPlaceOf(project, 'bbbbbbbb-0000-4000-8000-000000000001')?.worktreePath);
  });

  it('2. refuses a chat id that cannot name a place: too short, or with path characters only', () => {
    expect(runnerPlaceOf('/p', '../../etc')).toBeNull();
    expect(runnerPlaceOf('/p', 'abc')).toBeNull();
    expect(runnerPlaceOf('/p', '')).toBeNull();
    // What is not hex never reaches the path.
    expect(runnerPlaceOf('/p', '../../4f2a9c11-zz')?.worktreePath).toBe(path.join('/p', '.worktrees', 'chat-4f2a9c11'));
  });

  it("3. starts from origin's default branch, never the root's current one", () => {
    expect(startPointOf({ originHead: 'origin/main', refs: ['origin/main', 'feature-x', 'main'] })).toBe('origin/main');
    expect(startPointOf({ originHead: 'origin/trunk', refs: ['origin/trunk'] })).toBe('origin/trunk');
    // No origin/HEAD recorded: origin/main, then origin/master.
    expect(startPointOf({ originHead: null, refs: ['origin/master', 'feature-x'] })).toBe('origin/master');
    expect(startPointOf({ originHead: null, refs: ['origin/main', 'origin/master'] })).toBe('origin/main');
    // origin's branch before the local one of the same name, which may be anywhere.
    expect(startPointOf({ originHead: null, refs: ['main', 'origin/main', 'feature-x'] })).toBe('origin/main');
    expect(startPointOf({ originHead: null, refs: ['master', 'origin/master'] })).toBe('origin/master');
  });

  it('3. with no remote, from the local default branch; with none at all, nowhere', () => {
    expect(startPointOf({ originHead: null, refs: ['main', 'feature-x'] })).toBe('main');
    expect(startPointOf({ originHead: null, refs: ['master'] })).toBe('master');
    expect(startPointOf({ originHead: null, refs: ['feature-x'] })).toBeNull();
  });
});

describe('a slot freed by a sleep', () => {
  const at = (minutes: number) => Date.parse('2026-10-12T08:00:00.000Z') + minutes * 60_000;

  it("4, 6. sleeps the least recently active runner the rule allows, never Main's", () => {
    expect(victimOf([
      { agentId: 'main', isMain: true, lastActivity: at(0), refusal: null },
      { agentId: 'recent', isMain: false, lastActivity: at(30), refusal: null },
      { agentId: 'older', isMain: false, lastActivity: at(10), refusal: null },
    ])).toBe('older');
  });

  it('5. passes over a runner the sleep rule refuses', () => {
    expect(victimOf([
      { agentId: 'busy', isMain: false, lastActivity: at(0), refusal: 'not-at-rest' },
      { agentId: 'owed', isMain: false, lastActivity: at(1), refusal: 'owes' },
      { agentId: 'free', isMain: false, lastActivity: at(5), refusal: null },
    ])).toBe('free');
  });

  it('7. chooses nobody when nobody may sleep', () => {
    expect(victimOf([
      { agentId: 'main', isMain: true, lastActivity: at(0), refusal: null },
      { agentId: 'busy', isMain: false, lastActivity: at(1), refusal: 'field' },
    ])).toBeNull();
    expect(victimOf([])).toBeNull();
  });
});

describe('after a crash', () => {
  it('8. resumes the most recently active runners, as many as the slots left, and leaves the rest asleep', () => {
    const working = [
      { agentId: 'a', lastActivity: 1 }, { agentId: 'b', lastActivity: 3 }, { agentId: 'c', lastActivity: 2 },
    ];
    expect(runnersToResume(working, 2)).toEqual({ resume: ['b', 'c'], leave: ['a'] });
    expect(runnersToResume(working, 5)).toEqual({ resume: ['b', 'c', 'a'], leave: [] });
    expect(runnersToResume(working, 0)).toEqual({ resume: [], leave: ['b', 'c', 'a'] });
    expect(runnersToResume(working, -1)).toEqual({ resume: [], leave: ['b', 'c', 'a'] });
  });
});

describe('the sentence of a full limit', () => {
  it('9. says how many, the RAM and the rule, and who works', () => {
    expect(chatLimitSentence(3, 16, 5, ['Release 1.9.4', 'Bug #12', 'Design'])).toBe(
      '3 chats are already working, the most this Mac runs at once (16 GB of RAM, one chat per 5 GB). '
      + 'Wait for one to finish, or stop one: Release 1.9.4, Bug #12, Design.',
    );
    expect(chatLimitSentence(1, 8, 5, ['Main'])).toBe(
      '1 chat is already working, the most this Mac runs at once (8 GB of RAM, one chat per 5 GB). '
      + 'Wait for it to finish, or stop it: Main.',
    );
  });
});
