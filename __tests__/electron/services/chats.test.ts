/**
 * The chats' records (ORCHESTRATOR-PER-CHAT.md v2.2, 4.1 and 4.6, PR C):
 * `~/.dorothy/chats.json`, one record per chat of a project, and the
 * migration that makes each project's orchestrator's conversation its chat
 * #1, "Main" (electron/services/chats.ts). The store keeps the records; who
 * runs a chat (PR D) and what it says (PR E) are not here.
 *
 * How it fails, written before the code (2026-10-12):
 * The file
 * 1. A write that dies half way leaves a file the next launch cannot read.
 * 2. A file that is not JSON, or not the chats' shape, is replaced by an
 *    empty list at the next write: every chat lost without a word. It must be
 *    set aside under a name of its own, byte for byte, and reported.
 * 3. A second bad file is set aside over the first one.
 * 4. A file written by a newer Tars is rewritten in this version's shape,
 *    losing what this one does not know.
 * 5. A file that cannot be read (its permissions) is taken as empty, and
 *    written over.
 * 6. A record that does not hold (a field missing or of the wrong type, an id
 *    twice, a number twice in a project, a counter below a number in use) is
 *    kept and breaks a reader, or is dropped without a word.
 * 7. Two inboxes in a project, or none, survive a load.
 * 8. A read writes the file, or a launch that changes nothing writes it again:
 *    the bytes must stay what they were.
 * 9. A record handed out is the store's own: a caller changing it changes the
 *    store.
 * Numbers
 * 10. A deleted chat's number is handed out again: an old Telegram reply to
 *     "#3" would reach a newer chat.
 * 11. Numbers are counted across projects, or from how many chats there are,
 *     instead of per project from a counter that only goes up.
 * The migration
 * 12. Main is made for a project without an orchestrator.
 * 13. Main is made twice: a second call, or a second launch.
 * 14. Main is not number 1, not the inbox, not titled "Main", or its title is
 *     left open to the automatic summary.
 * 15. Main misses the orchestrator's conversation (its resumableSessionId),
 *     or takes an id that is not a session's.
 * 16. Main's createdAt is not the orchestrator's.
 * 17. A Main the user deleted comes back at the next launch.
 * 18. A project whose orchestrator is set after the migration never gets its
 *     Main.
 * Create, rename, pin, snooze, settle, the inbox, delete
 * 19. A chat is made for a project with no orchestrator, or under another
 *     spelling of a project's path (a link), which then has two lists.
 * 20. A title that is empty, blank, not text, longer than 80 characters, or
 *     several lines with control or bidi characters is kept as it came.
 * 21. A rename leaves the title open to the automatic summary.
 * 22. A snooze to a time already past, or to something that is not a time, is
 *     taken; null does not end it.
 * 23. Settling again moves the time it was settled; unsettling leaves it.
 * 24. A pin or a settle that is not a boolean is read as one.
 * 25. Making a chat the inbox leaves two in its project, or takes another
 *     project's.
 * 26. The inbox, or a chat whose runner has work out at the team, is deleted;
 *     an unknown id deletes something, or throws.
 * 27. A write that fails (a permission, a full disk) leaves the store and the
 *     file different, and the change is answered as made.
 * 28. A change that changes nothing (pinning a pinned chat) writes the file.
 * The session mirror
 * 29. A new session of a chat's runner is not added to its sessionIds, is
 *     added twice, or another agent's session is added.
 * Work out (`chat_has_work`)
 * 30. A request of the runner still out at another agent, queued or in hand,
 *     is not counted; another asker's is; work asked of the runner itself is;
 *     a link an older Tars left (no request id) is not.
 * The limit
 * 31. Not one chat per 5 GB of RAM from 1 to 8 (8 GB 1, 16 GB 3, 24 GB 4,
 *     32 GB 6, 64 GB and more 8, below 10 GB 1), or a GB read as 10^9 bytes.
 * 32. The E2E's RAM figure (TARS_CHAT_RAM_GB) is read outside an E2E run, or
 *     one that is not a positive number is taken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createChatStore, chatLimitOf, workOutOf,
  type Chat, type ChatError, type ChatStore, type OrchestratorFacts, type WorkItem,
} from '../../../electron/services/chats';

const SESSION_A = 'e2e00000-0000-4000-8000-0000000000aa';
const SESSION_B = 'e2e00000-0000-4000-8000-0000000000bb';
const T0 = '2026-10-12T08:00:00.000Z';

let dir: string;
let file: string;
let projA: string;
let projB: string;
let t: number;
let n: number;
const locked: string[] = [];

const open = (): ChatStore => createChatStore({ file, now: () => t, newId: () => `chat-${++n}` });
const isError = (v: unknown): v is ChatError => !!v && typeof v === 'object' && 'error' in v;
/** The chat an operation answered, or the test fails with the error it answered instead. */
const ok = (v: Chat | ChatError): Chat => {
  if (isError(v)) throw new Error(`${v.error}: ${v.reason}`);
  return v;
};
const errorOf = (v: unknown): string | undefined => (isError(v) ? v.error : undefined);
const orch = (over: Partial<OrchestratorFacts> = {}): OrchestratorFacts => ({
  id: 'o1', projectPath: projA, createdAt: '2026-10-01T08:00:00.000Z', lastActivity: '2026-10-10T09:00:00.000Z',
  resumableSessionId: SESSION_A, ...over,
});
const orchB = (): OrchestratorFacts => orch({ id: 'o2', projectPath: projB, resumableSessionId: undefined });
const chats = (store: ChatStore) => store.list().chats;
const main = (store: ChatStore, project = projA) => chats(store).find(c => c.projectPath === project && c.number === 1)!;
const bytes = () => fs.readFileSync(file);

/** A record as the file holds it, valid unless a test spoils it. */
const record = (over: Partial<Chat> = {}): Chat => ({
  id: 'r1', projectPath: projA, number: 1, title: 'Main', titleSource: 'user', runnerId: 'o1', sessionIds: [SESSION_A],
  pinned: false, snoozedUntil: null, settledAt: null, inbox: true,
  createdAt: '2026-10-01T08:00:00.000Z', updatedAt: T0, lastActivityAt: T0, ...over,
});
const writeFile = (body: unknown) => fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-'));
  file = path.join(dir, 'chats.json');
  projA = path.join(dir, 'projects', 'a');
  projB = path.join(dir, 'projects', 'b');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });
  t = Date.parse(T0);
  n = 0;
});

afterEach(() => {
  // Whatever a test made unreadable or unwritable is given back, so the
  // temporary folder can be cleaned.
  for (const p of locked.splice(0)) fs.chmodSync(p, 0o700);
});

describe("the migration: each project's orchestrator's conversation is its chat #1, Main", () => {
  it('12, 14, 15, 16. makes Main for a project with an orchestrator, bound to it, and none for a project without one', () => {
    const store = open();
    expect(store.ensureMains([orch()])).toHaveLength(1);
    expect(chats(store)).toHaveLength(1);
    expect(main(store)).toEqual({
      id: 'chat-1', projectPath: projA, number: 1, title: 'Main', titleSource: 'user', runnerId: 'o1',
      sessionIds: [SESSION_A], pinned: false, snoozedUntil: null, settledAt: null, inbox: true,
      createdAt: '2026-10-01T08:00:00.000Z', updatedAt: T0, lastActivityAt: '2026-10-10T09:00:00.000Z',
    });
    expect(chats(store).some(c => c.projectPath === projB)).toBe(false);
  });

  it('15. leaves the sessions empty for an orchestrator with no conversation, or an id that is not a session\'s', () => {
    const store = open();
    store.ensureMains([orch({ resumableSessionId: undefined }), orch({ id: 'o2', projectPath: projB, resumableSessionId: 'not a session id' })]);
    expect(main(store).sessionIds).toEqual([]);
    expect(main(store, projB).sessionIds).toEqual([]);
  });

  it('16. takes the time of the migration when the orchestrator has no creation time that reads', () => {
    const store = open();
    store.ensureMains([orch({ createdAt: undefined, lastActivity: undefined }), orch({ id: 'o2', projectPath: projB, createdAt: 'yesterday' })]);
    expect(main(store).createdAt).toBe(T0);
    expect(main(store).lastActivityAt).toBe(T0);
    expect(main(store, projB).createdAt).toBe(T0);
  });

  it('13. makes Main once: a second call and a second launch change nothing, byte for byte', () => {
    const first = open();
    first.ensureMains([orch()]);
    const before = bytes();
    expect(first.ensureMains([orch()])).toEqual([]);
    t += 60_000;
    const again = open();
    expect(again.ensureMains([orch()])).toEqual([]);
    expect(chats(again)).toHaveLength(1);
    expect(bytes().equals(before)).toBe(true);
  });

  it('17. never brings back a Main the user deleted', () => {
    const store = open();
    store.ensureMains([orch()]);
    const other = ok(store.create({ projectPath: projA, title: 'Release' }, [orch()]));
    ok(store.setInbox(other.id));
    expect(store.remove(main(store).id, () => [])).toEqual({ success: true });
    const again = open();
    expect(again.ensureMains([orch()])).toEqual([]);
    expect(chats(again).map(c => c.number)).toEqual([2]);
  });

  it('13, 17. makes no Main for a project whose counter says it had chats, though none is left: #1 is not handed out again', () => {
    writeFile({ version: 1, numbers: { [projA]: 3 }, chats: [] });
    const store = open();
    expect(store.problem()).toBeNull();
    expect(store.ensureMains([orch()])).toEqual([]);
    expect(chats(store)).toEqual([]);
    expect(ok(store.create({ projectPath: projA, title: 'Again' }, [orch()]))).toMatchObject({ number: 4, inbox: true });
  });

  it('18. makes Main for a project whose orchestrator was set after the migration', () => {
    const store = open();
    expect(store.ensureMains([])).toEqual([]);
    expect(store.ensureMains([orch()])).toHaveLength(1);
    expect(main(store).runnerId).toBe('o1');
  });

  it('8. writes nothing when there is nothing to make', () => {
    const store = open();
    store.ensureMains([]);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('numbers', () => {
  it("10, 11. are per project, from 1, and a deleted chat's number is never handed out again", () => {
    const store = open();
    store.ensureMains([orch(), orchB()]);
    const two = ok(store.create({ projectPath: projA, title: 'Two' }, [orch(), orchB()]));
    const three = ok(store.create({ projectPath: projA, title: 'Three' }, [orch(), orchB()]));
    expect([two.number, three.number]).toEqual([2, 3]);
    expect(store.remove(three.id, () => [])).toEqual({ success: true });
    expect(ok(store.create({ projectPath: projA, title: 'Four' }, [orch(), orchB()])).number).toBe(4);
    expect(ok(store.create({ projectPath: projB, title: 'B two' }, [orch(), orchB()])).number).toBe(2);
    // And after a relaunch, from the counter the file kept.
    expect(store.remove(chats(store).find(c => c.title === 'Four')!.id, () => [])).toEqual({ success: true });
    expect(ok(open().create({ projectPath: projA, title: 'Five' }, [orch(), orchB()])).number).toBe(5);
  });
});

describe('the file', () => {
  it('2. sets a file that is not JSON aside, byte for byte, says so, and starts again', () => {
    writeFile('{"version":1,"chats":[{"id":');
    const store = open();
    const problem = store.problem();
    expect(problem?.kind).toBe('corrupt');
    expect(problem?.file && path.dirname(problem.file)).toBe(dir);
    expect(fs.readFileSync(problem!.file!, 'utf8')).toBe('{"version":1,"chats":[{"id":');
    expect(chats(store)).toEqual([]);
    store.ensureMains([orch()]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).chats).toHaveLength(1);
    expect(fs.readFileSync(problem!.file!, 'utf8')).toBe('{"version":1,"chats":[{"id":');
  });

  it("2. sets aside a file that is JSON but not the chats' shape", () => {
    for (const body of ['[]', '{"chats":[]}', '{"version":"1","chats":[],"numbers":{}}', 'null']) {
      writeFile(body);
      const store = open();
      expect(store.problem()?.kind, body).toBe('corrupt');
      expect(fs.existsSync(file), body).toBe(false);
      t += 1000;
    }
  });

  it('3. never sets a bad file aside over one set aside before', () => {
    writeFile('first bad file');
    const first = open().problem()!.file!;
    writeFile('second bad file');
    const second = open().problem()!.file!;
    expect(second).not.toBe(first);
    expect(fs.readFileSync(first, 'utf8')).toBe('first bad file');
    expect(fs.readFileSync(second, 'utf8')).toBe('second bad file');
  });

  it('4. leaves a file written by a newer Tars as it is, and refuses to change it', () => {
    writeFile({ version: 2, numbers: {}, chats: [], somethingNew: true });
    const before = bytes();
    const store = open();
    expect(store.problem()?.kind).toBe('newer');
    expect(store.ensureMains([orch()])).toEqual([]);
    expect(errorOf(store.create({ projectPath: projA }, [orch()]))).toBe('chats_unavailable');
    expect(chats(store)).toEqual([]);
    expect(bytes().equals(before)).toBe(true);
  });

  it('5. never takes a file it cannot read for an empty one', () => {
    open().ensureMains([orch()]);
    const before = bytes();
    fs.chmodSync(file, 0o000);
    locked.push(file);
    const store = open();
    expect(store.problem()?.kind).toBe('unreadable');
    expect(store.ensureMains([orch()])).toEqual([]);
    expect(errorOf(store.create({ projectPath: projA }, [orch()]))).toBe('chats_unavailable');
    fs.chmodSync(file, 0o600);
    expect(bytes().equals(before)).toBe(true);
  });

  it('6. drops a record that does not hold, keeps the file as it was aside, and says how many', () => {
    const body = {
      version: 1,
      numbers: { [projA]: 2 },
      chats: [
        record(),
        { id: 'broken' },
        record({ id: 'r1', number: 2, title: 'Same id' }),
        record({ id: 'r3', number: 1, title: 'Same number', inbox: false }),
        record({ id: 'r4', number: 2, title: 7 as unknown as string, inbox: false }),
        record({ id: 'r5', number: 2, title: 'Good two', inbox: false, sessionIds: ['ok-id', 3 as unknown as string] }),
        record({ id: 'r6', number: 2, title: 'Good two', inbox: false, snoozedUntil: 'soon' }),
        record({ id: 'r7', number: 2, title: 'Good two', inbox: false, titleSource: 'robot' as 'user' }),
      ],
    };
    writeFile(body);
    const original = bytes();
    const store = open();
    expect(store.problem()).toMatchObject({ kind: 'repaired', dropped: 7 });
    expect(fs.readFileSync(store.problem()!.file!).equals(original)).toBe(true);
    expect(chats(store).map(c => c.id)).toEqual(['r1']);
    // The file now holds what the store holds, so the next launch finds nothing to set aside.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).chats.map((c: Chat) => c.id)).toEqual(['r1']);
    expect(open().problem()).toBeNull();
  });

  it('6. raises a counter that is below a number in use, so that number is never handed out again', () => {
    writeFile({ version: 1, numbers: { [projA]: 1 }, chats: [record(), record({ id: 'r3', number: 3, title: 'Three', inbox: false })] });
    const store = open();
    expect(store.problem()?.kind).toBe('repaired');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).numbers[projA]).toBe(3);
    // #3 deleted: the next is #4, not #3 again (nor #2, which the counter's own say would give).
    expect(store.remove('r3', () => [])).toEqual({ success: true });
    expect(ok(store.create({ projectPath: projA, title: 'Next' }, [orch()])).number).toBe(4);
  });

  it('7. keeps exactly one inbox in each project that has chats', () => {
    writeFile({
      version: 1,
      numbers: { [projA]: 2, [projB]: 3 },
      chats: [
        record({ id: 'a2', number: 2, title: 'A two', inbox: true }),
        record({ id: 'a1', number: 1, title: 'A one', inbox: true }),
        record({ id: 'b3', projectPath: projB, number: 3, title: 'B three', inbox: false }),
        record({ id: 'b2', projectPath: projB, number: 2, title: 'B two', inbox: false }),
      ],
    });
    const store = open();
    expect(store.problem()?.kind).toBe('repaired');
    const inboxes = chats(store).filter(c => c.inbox).map(c => c.id).sort();
    expect(inboxes).toEqual(['a1', 'b2']);
  });

  it('8. a read writes nothing, and a launch that changes nothing leaves the bytes as they were', () => {
    const store = open();
    store.ensureMains([orch()]);
    ok(store.create({ projectPath: projA, title: 'Two' }, [orch()]));
    const before = bytes();
    const mtime = fs.statSync(file).mtimeMs;
    t += 3_600_000;
    const again = open();
    expect(again.problem()).toBeNull();
    again.list();
    again.ensureMains([orch()]);
    expect(bytes().equals(before)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it('9. hands out copies: changing one changes nothing in the store', () => {
    const store = open();
    store.ensureMains([orch()]);
    const [copy] = chats(store);
    copy.title = 'Changed';
    copy.sessionIds.push(SESSION_B);
    expect(main(store).title).toBe('Main');
    expect(main(store).sessionIds).toEqual([SESSION_A]);
  });

  it('1. writes through a temporary file: none is left, and the file reads back whole', () => {
    const store = open();
    store.ensureMains([orch()]);
    ok(store.create({ projectPath: projA, title: 'Two' }, [orch()]));
    expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ version: 1, numbers: { [projA]: 2 } });
  });

  it('27. a write that fails changes nothing, and says so', () => {
    const store = open();
    store.ensureMains([orch()]);
    const before = bytes();
    fs.chmodSync(dir, 0o500);
    locked.push(dir);
    const answer = store.rename(main(store).id, 'Renamed');
    expect(errorOf(answer)).toBe('write_failed');
    expect(main(store).title).toBe('Main');
    expect(errorOf(store.create({ projectPath: projA, title: 'Two' }, [orch()]))).toBe('write_failed');
    expect(chats(store)).toHaveLength(1);
    fs.chmodSync(dir, 0o700);
    expect(bytes().equals(before)).toBe(true);
    // And the counter did not move: the next chat is still #2.
    expect(ok(store.create({ projectPath: projA, title: 'Two' }, [orch()])).number).toBe(2);
  });
});

describe('create', () => {
  it('19. refuses a project that has no orchestrator, and says why', () => {
    const store = open();
    const answer = store.create({ projectPath: projB, title: 'Nope' }, [orch()]);
    expect(errorOf(answer)).toBe('no_orchestrator');
    expect((answer as ChatError).reason).toMatch(/orchestrator/);
    expect(errorOf(store.create({ projectPath: 42 }, [orch()]))).toBe('no_orchestrator');
    expect(chats(store).filter(c => c.projectPath === projB)).toEqual([]);
  });

  it('19. files a chat made under another spelling of the path under the path Tars saved', () => {
    const link = path.join(dir, 'link-to-a');
    fs.symlinkSync(projA, link);
    const store = open();
    store.ensureMains([orch()]);
    const made = ok(store.create({ projectPath: link, title: 'Through the link' }, [orch()]));
    expect(made.projectPath).toBe(projA);
    expect(made.number).toBe(2);
  });

  it('makes a chat with no runner yet, not the inbox, called "New chat" until it is named', () => {
    const store = open();
    store.ensureMains([orch()]);
    t += 5_000;
    const made = ok(store.create({ projectPath: projA }, [orch()]));
    expect(made).toEqual({
      id: 'chat-2', projectPath: projA, number: 2, title: 'New chat', titleSource: 'auto', runnerId: null, sessionIds: [],
      pinned: false, snoozedUntil: null, settledAt: null, inbox: false,
      createdAt: '2026-10-12T08:00:05.000Z', updatedAt: '2026-10-12T08:00:05.000Z', lastActivityAt: '2026-10-12T08:00:05.000Z',
    });
  });

  it("18. makes the project's Main first when its orchestrator came after the launch", () => {
    const store = open();
    const made = ok(store.create({ projectPath: projA, title: 'First of mine' }, [orch()]));
    expect(made.number).toBe(2);
    expect(chats(store).map(c => [c.number, c.title])).toEqual([[1, 'Main'], [2, 'First of mine']]);
  });
});

describe('the title', () => {
  it('20. refuses a title that is not one line of 1 to 80 characters', () => {
    const store = open();
    store.ensureMains([orch()]);
    for (const title of ['', '   ', 42, null, 'x'.repeat(81), '‮⁦']) {
      expect(errorOf(store.rename(main(store).id, title)), JSON.stringify(title)).toBe('invalid_title');
    }
    expect(errorOf(store.create({ projectPath: projA, title: '' }, [orch()]))).toBe('invalid_title');
    expect(ok(store.rename(main(store).id, 'é'.repeat(80))).title).toBe('é'.repeat(80));
  });

  it('20. makes one line of it: breaks and tabs become spaces, control and bidi characters go', () => {
    const store = open();
    store.ensureMains([orch()]);
    expect(ok(store.rename(main(store).id, '  Release\n1.9.4\t\tnow  ')).title).toBe('Release 1.9.4 now');
    expect(ok(store.rename(main(store).id, 'a‮b\u0007c⁦d')).title).toBe('abcd');
  });

  it("21. a rename is the user's: the automatic summary never replaces it", () => {
    const store = open();
    store.ensureMains([orch()]);
    const made = ok(store.create({ projectPath: projA }, [orch()]));
    expect(made.titleSource).toBe('auto');
    const renamed = ok(store.rename(made.id, 'Bug #12'));
    expect(renamed).toMatchObject({ title: 'Bug #12', titleSource: 'user' });
    expect(ok(store.create({ projectPath: projA, title: 'Named' }, [orch()])).titleSource).toBe('user');
  });
});

describe('pin, snooze, settle', () => {
  let store: ChatStore;
  let id: string;
  beforeEach(() => {
    store = open();
    store.ensureMains([orch()]);
    id = main(store).id;
  });

  it('24. pin takes a boolean, and nothing else', () => {
    expect(errorOf(store.pin(id, 'yes'))).toBe('invalid_request');
    expect(main(store).pinned).toBe(false);
    expect(ok(store.pin(id, true)).pinned).toBe(true);
    expect(ok(store.pin(id, false)).pinned).toBe(false);
  });

  it('22. snoozes until a time to come; null ends it; the past and what is not a time are refused', () => {
    expect(ok(store.snooze(id, '2026-10-13T08:00:00.000Z')).snoozedUntil).toBe('2026-10-13T08:00:00.000Z');
    for (const until of ['2026-10-11T08:00:00.000Z', T0, 'tomorrow', 17, {}]) {
      expect(errorOf(store.snooze(id, until)), JSON.stringify(until)).toBe('invalid_until');
    }
    expect(main(store).snoozedUntil).toBe('2026-10-13T08:00:00.000Z');
    expect(ok(store.snooze(id, null)).snoozedUntil).toBeNull();
  });

  it('23, 24. settling again keeps the first time; unsettling clears it; a settle that is not a boolean is refused', () => {
    expect(ok(store.settle(id, true)).settledAt).toBe(T0);
    t += 60_000;
    expect(ok(store.settle(id, true)).settledAt).toBe(T0);
    expect(errorOf(store.settle(id, 'no'))).toBe('invalid_request');
    expect(ok(store.settle(id, false)).settledAt).toBeNull();
  });

  it('28. a change that changes nothing writes nothing; a change moves updatedAt and the seq, never lastActivityAt', () => {
    ok(store.pin(id, true));
    const before = bytes();
    const seq = store.list().seq;
    t += 60_000;
    expect(ok(store.pin(id, true)).updatedAt).toBe(T0);
    expect(bytes().equals(before)).toBe(true);
    expect(store.list().seq).toBe(seq);
    const renamed = ok(store.rename(id, 'Main, renamed'));
    expect(renamed.updatedAt).toBe('2026-10-12T08:01:00.000Z');
    expect(renamed.lastActivityAt).toBe('2026-10-10T09:00:00.000Z');
    expect(store.list().seq).toBe(seq + 1);
  });

  it('26. an id that names no chat is answered not_found, and changes nothing', () => {
    const before = bytes();
    for (const unknown of ['nope', 42, undefined]) {
      expect(errorOf(store.pin(unknown, true))).toBe('not_found');
      expect(errorOf(store.rename(unknown, 'x'))).toBe('not_found');
      expect(errorOf(store.snooze(unknown, null))).toBe('not_found');
      expect(errorOf(store.settle(unknown, true))).toBe('not_found');
      expect(errorOf(store.setInbox(unknown))).toBe('not_found');
      expect(store.remove(unknown, () => [])).toMatchObject({ error: 'not_found' });
    }
    expect(bytes().equals(before)).toBe(true);
  });
});

describe('the inbox', () => {
  it("25. one per project: making a chat the inbox moves it within that chat's project only", () => {
    const store = open();
    store.ensureMains([orch(), orchB()]);
    const other = ok(store.create({ projectPath: projA, title: 'Inbox to be' }, [orch(), orchB()]));
    expect(ok(store.setInbox(other.id)).inbox).toBe(true);
    expect(main(store).inbox).toBe(false);
    expect(main(store, projB).inbox).toBe(true);
    expect(chats(store).filter(c => c.projectPath === projA && c.inbox)).toHaveLength(1);
  });
});

describe('delete', () => {
  let store: ChatStore;
  beforeEach(() => {
    store = open();
    store.ensureMains([orch()]);
  });
  const item: WorkItem = { workerId: 'w1', workerName: 'Worker', ref: 't-0000abcd', state: 'queued', queuedAt: T0 };

  it('26. refuses the inbox, and says what to do', () => {
    const answer = store.remove(main(store).id, () => []);
    expect(answer).toMatchObject({ error: 'inbox' });
    expect((answer as ChatError).reason).toMatch(/inbox/);
    expect(chats(store)).toHaveLength(1);
  });

  it("26. refuses a chat whose runner has work out, and lists that work", () => {
    const other = ok(store.create({ projectPath: projA, title: 'Inbox now' }, [orch()]));
    ok(store.setInbox(other.id));
    const seen: Array<string | null> = [];
    const answer = store.remove(main(store).id, chat => { seen.push(chat.runnerId); return [item]; });
    expect(answer).toMatchObject({ error: 'chat_has_work', tasks: [item] });
    expect(seen).toEqual(['o1']);
    expect(chats(store)).toHaveLength(2);
  });

  it('26. removes a chat with nothing out, and only that one', () => {
    const other = ok(store.create({ projectPath: projA, title: 'To go' }, [orch()]));
    expect(store.remove(other.id, () => [])).toEqual({ success: true });
    expect(chats(store).map(c => c.id)).toEqual([main(store).id]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).chats).toHaveLength(1);
  });
});

describe("the sessions: each one the runner's conversation goes through", () => {
  it("29. adds a runner's new session once, oldest first, and no other agent's", () => {
    const store = open();
    store.ensureMains([orch()]);
    t += 60_000;
    expect(store.noteSession('o1', SESSION_B)).toBe(true);
    expect(main(store).sessionIds).toEqual([SESSION_A, SESSION_B]);
    expect(main(store).lastActivityAt).toBe('2026-10-12T08:01:00.000Z');
    const before = bytes();
    expect(store.noteSession('o1', SESSION_B)).toBe(false);
    expect(store.noteSession('o1', SESSION_A)).toBe(false);
    expect(store.noteSession('w1', 'e2e00000-0000-4000-8000-0000000000cc')).toBe(false);
    expect(store.noteSession('o1', 'not a session id')).toBe(false);
    expect(store.noteSession('o1', undefined)).toBe(false);
    expect(bytes().equals(before)).toBe(true);
    expect(main(open()).sessionIds).toEqual([SESSION_A, SESSION_B]);
  });

  it('29. adds it only to the chats of that runner that lack it', () => {
    writeFile({
      version: 1,
      numbers: { [projA]: 2 },
      chats: [record({ sessionIds: [SESSION_A, SESSION_B] }), record({ id: 'r2', number: 2, title: 'Two', inbox: false, sessionIds: [SESSION_A] })],
    });
    const store = open();
    expect(store.noteSession('o1', SESSION_B)).toBe(true);
    expect(chats(store).map(c => c.sessionIds)).toEqual([[SESSION_A, SESSION_B], [SESSION_A, SESSION_B]]);
  });
});

describe('work out at the team (chat_has_work)', () => {
  it('30. counts the requests the runner has out at other agents, queued or in hand, and nothing else', () => {
    const queuedAt = T0;
    const fleet = [
      { id: 'w1', name: 'Worker', taskQueue: [
        { ref: 't-00000001', requesterAgentId: 'o1', queuedAt, state: 'queued' as const },
        { ref: 't-00000002', requesterAgentId: 'b1', queuedAt, state: 'queued' as const },
      ] },
      { id: 'w2', name: 'Other', taskQueue: [{ ref: 't-00000003', requesterAgentId: 'o1', queuedAt, state: 'delivered' as const }],
        requestedBy: { agentId: 'o1', ptyId: 'p2', taskRef: 't-00000003' } },
      { id: 'w3', name: 'Legacy', requestedBy: { agentId: 'o1', ptyId: 'p3' } },
      // Work asked of the runner, by others or by itself, is not the chat's work out.
      { id: 'o1', name: 'Lead', taskQueue: [
        { ref: 't-00000004', requesterAgentId: 'w1', queuedAt, state: 'queued' as const },
        { ref: 't-00000005', requesterAgentId: 'o1', queuedAt, state: 'queued' as const },
      ], requestedBy: { agentId: 'o1', ptyId: 'p0' } },
    ];
    expect(workOutOf('o1', fleet)).toEqual([
      { workerId: 'w1', workerName: 'Worker', ref: 't-00000001', state: 'queued', queuedAt },
      { workerId: 'w2', workerName: 'Other', ref: 't-00000003', state: 'delivered', queuedAt },
      { workerId: 'w3', workerName: 'Legacy', ref: null, state: 'delivered', queuedAt: null },
    ]);
    expect(workOutOf('b1', fleet).map(w => w.ref)).toEqual(['t-00000002']);
    expect(workOutOf(null, fleet)).toEqual([]);
    expect(workOutOf('nobody', fleet)).toEqual([]);
  });
});

describe('the limit on chats working at once', () => {
  const GB = 2 ** 30;

  it('31. one chat per 5 GB of RAM, from 1 to 8, a GB being 2^30 bytes', () => {
    const limit = (gb: number) => chatLimitOf(gb * GB, {}).limit;
    expect([4, 8, 9.9, 10, 16, 24, 32, 39.9, 40, 64, 200].map(limit)).toEqual([1, 1, 1, 2, 3, 4, 6, 7, 8, 8, 8]);
    expect(chatLimitOf(16 * GB, {})).toEqual({ limit: 3, ramGb: 16, perChatGb: 5, min: 1, max: 8, source: 'ram' });
    // 16 * 10^9 bytes is 14.9 GB: two chats, not three.
    expect(chatLimitOf(16e9, {})).toMatchObject({ limit: 2, ramGb: 14.9 });
  });

  it("32. the E2E's figure is read in an E2E run only, and only a positive number", () => {
    expect(chatLimitOf(16 * GB, { TARS_CHAT_RAM_GB: '10' })).toMatchObject({ limit: 3, ramGb: 16, source: 'ram' });
    expect(chatLimitOf(16 * GB, { DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: '10' })).toMatchObject({ limit: 2, ramGb: 10, source: 'override' });
    for (const bad of ['abc', '0', '-5', '', 'Infinity']) {
      expect(chatLimitOf(16 * GB, { DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: bad }), bad).toMatchObject({ limit: 3, source: 'ram' });
    }
  });
});
