import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import type { AgentStatus } from '../types';
import { agents, saveAgents } from '../core/agent-manager';
import { ptyProcesses, writeProgrammaticInput } from '../core/pty-manager';
import { dialogOpen, launchAgent, sessionStarted, SENDER_WAIT_MS } from '../core/agent-launch';
import { fallAsleep } from '../core/agent-asleep';
import { diskRefusal, freeSpace } from '../core/disk-space';
import { restartForSettings } from '../core/agent-restart';
import { stopAgent } from '../core/agent-stop';
import { removeAgent } from '../core/agent-remove';
import { chatLimitSentence, runnerNameOf, runnerPlaceOf, runnersToResume, startPointOf, victimOf } from '../core/chat-slots';
import { getProvider } from '../providers';
import { resumeOnNextStart } from '../utils/resume-session';
import { broadcastToAllWindows } from '../utils/broadcast';
import { scheduleTick } from '../utils/agents-tick';
import { agentStatusEmitter, emitAgentStatus } from './agent-events';
import { factsOf, sleepNow, sleepRefusal } from './agent-sleep';
import { readProcesses } from './stall-watch';
import { cloneDependencies, logDependencies } from './worktree-deps';
import { chatLimitOf, type Chat, type ChatStore } from './chats';

/**
 * A chat's conversation, run (ORCHESTRATOR-PER-CHAT.md v2.2, 4.2; PR D of 2.0.0).
 *
 * Each chat other than Main gets, at its first send, a runner: an agent record
 * of its own, stored as a worker of `kind: 'chat'`, named "<orchestrator> ·
 * <title>", launched like the orchestrator (its instructions, its tool block,
 * its model, read from the orchestrator at each launch), in a worktree of its
 * own made from origin's default branch. Main's runner is the orchestrator.
 *
 * A send reaches the runner as the user's own words: typed into its CLI when
 * it runs (Claude Code takes them during a turn too), or as the prompt of a
 * launch that resumes its conversation when it does not.
 *
 * How many chats run at once is bounded by the RAM (chats.ts, chatLimitOf),
 * Main counted. A send that needs a slot when none is free puts the least
 * recently active runner the sleep rule allows to sleep (its 30 minutes
 * aside, never Main's), or answers `chat_limit` with the sentence and who
 * works: never a silent wait (Noah, 07/10). One lock holds the count, the
 * choice, the sleep and the launch together, so two sends cannot both take
 * the last slot (the Audit's M5).
 */

export type SendAnswer =
  | { success: true; chatId: string; runnerId: string; how: 'typed' | 'held' | 'launched' }
  | SendError;

export interface SendError {
  error: 'not_found' | 'invalid_request' | 'no_orchestrator' | 'provider_unsupported' | 'disk_full'
    | 'chat_limit' | 'runner_failed' | 'chats_unavailable';
  reason: string;
  /** chat_limit: the limit, the RAM it comes from, and the chats working. */
  limit?: number;
  ramGb?: number;
  working?: Array<{ chatId: string; title: string; since: string }>;
}

const TEXT_MAX = 100_000;
/** A settled chat's runner that cannot sleep at once is tried again, this often and this many times. */
const SETTLE_RETRY_MS = 3_500;
const SETTLE_TRIES = 10;

let store: ChatStore | null = null;
/** Launches the allocator let through, which hold no terminal yet: they count against the limit. */
const reserved = new Set<string>();
/** What a runner is told at its next launch: it was left asleep at launch, over the limit. */
const notesForNextLaunch = new Map<string, string>();
let slotChain: Promise<unknown> = Promise.resolve();

/** One at a time: count the slots, choose whom to put to sleep, sleep it, and launch (M5). */
function withSlots<T>(fn: () => Promise<T>): Promise<T> {
  const run = slotChain.then(fn, fn);
  slotChain = run.catch(() => undefined);
  return run;
}

export function isLive(agent: AgentStatus): boolean {
  return !!agent.ptyId && ptyProcesses.has(agent.ptyId);
}

/** The project's orchestrator: its role, never a runner (H1). */
function leadOf(projectPath: string): AgentStatus | undefined {
  return [...agents.values()].find((a) => a.role === 'orchestrator' && a.kind !== 'chat' && a.projectPath === projectPath);
}

function announce(agent: AgentStatus): void {
  emitAgentStatus(agent.id);
  broadcastToAllWindows('agent:status', { type: 'status', agentId: agent.id, status: agent.status, timestamp: agent.lastActivity });
  scheduleTick();
}

/** The orchestrator's configuration, read at each launch, never copied once (4.2). */
function syncWithLead(runner: AgentStatus, lead: AgentStatus, chat: Chat): void {
  runner.name = runnerNameOf(lead.name, chat.title);
  runner.teamOrchestratorId = lead.id;
  runner.provider = lead.provider;
  runner.model = lead.model;
  runner.localModel = lead.localModel;
  runner.effort = lead.effort;
  runner.permissionMode = lead.permissionMode;
  runner.skipPermissions = lead.skipPermissions;
  runner.cliPath = lead.cliPath;
  runner.skills = [...(lead.skills ?? [])];
  runner.claudeAccountPin = lead.claudeAccountPin;
  runner.obsidianVaultPaths = [...(lead.obsidianVaultPaths ?? [])];
  runner.secondaryProjectPath = lead.secondaryProjectPath;
  runner.character = lead.character;
}

type Git = { code: number; stdout: string; stderr: string };
function git(cwd: string, args: string[]): Promise<Git> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

const failed = (reason: string): SendError => ({ error: 'runner_failed', reason });

/**
 * The runner of a chat's first send: its worktree, from origin's default
 * branch (fetched) or the local default branch's head, never the root's
 * current branch (R7); its dependencies cloned (#325); the project's
 * settings.local.json copied once; then its record.
 */
async function makeRunner(chat: Chat, lead: AgentStatus): Promise<{ runner: AgentStatus } | SendError> {
  const project = lead.projectPath;
  const place = runnerPlaceOf(project, chat.id);
  if (!place) return failed('This chat has no id a worktree can be named after.');
  if (fs.existsSync(place.worktreePath)) return failed(`A folder is already at ${place.worktreePath}: move it away, and send again.`);
  if ((await git(project, ['rev-parse', '--verify', '--quiet', `refs/heads/${place.branchName}`])).code === 0) {
    return failed(`A branch ${place.branchName} already exists in this project: delete or rename it, and send again.`);
  }
  const remotes = (await git(project, ['remote'])).stdout.split('\n').map((r) => r.trim());
  if (remotes.includes('origin')) {
    // Offline, the default branch as last fetched is where the runner starts.
    const fetched = await git(project, ['fetch', '--quiet', 'origin']);
    if (fetched.code !== 0) console.warn(`[chat-runners] git fetch origin failed in ${project}: ${fetched.stderr.trim()}`);
  }
  const head = await git(project, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const refs: string[] = [];
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await git(project, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code === 0) refs.push(ref);
  }
  const start = startPointOf({ originHead: head.code === 0 && head.stdout.trim() ? head.stdout.trim() : null, refs });
  if (!start) return failed('This project has no default branch to start a chat from (no origin/main, origin/master, main or master).');
  fs.mkdirSync(path.dirname(place.worktreePath), { recursive: true });
  const added = await git(project, ['worktree', 'add', '-b', place.branchName, place.worktreePath, start]);
  if (added.code !== 0) return failed(`Its worktree could not be made: ${added.stderr.trim() || 'git worktree add failed'}.`);
  await logDependencies(place.worktreePath, await cloneDependencies(project, place.worktreePath));
  // The grants the orchestrator has, copied once: they diverge after, as any worktree's do.
  const grants = path.join(project, '.claude', 'settings.local.json');
  if (fs.existsSync(grants)) {
    try {
      fs.mkdirSync(path.join(place.worktreePath, '.claude'), { recursive: true });
      fs.copyFileSync(grants, path.join(place.worktreePath, '.claude', 'settings.local.json'), fs.constants.COPYFILE_EXCL);
    } catch (err) {
      console.warn(`[chat-runners] settings.local.json not copied into ${place.worktreePath}: ${(err as Error).message}`);
    }
  }
  const now = new Date().toISOString();
  const runner: AgentStatus = {
    id: uuidv4(),
    status: 'idle',
    projectPath: project,
    worktreePath: place.worktreePath,
    branchName: place.branchName,
    skills: [],
    output: [],
    lastActivity: now,
    createdAt: now,
    role: 'worker',
    orchestratorMode: false,
    kind: 'chat',
    chatId: chat.id,
  };
  syncWithLead(runner, lead, chat);
  agents.set(runner.id, runner);
  saveAgents();
  const bound = store!.setRunner(chat.id, runner.id);
  if ('error' in bound) {
    await removeAgent(runner.id);
    return failed(`The chat could not take its runner: ${bound.reason}`);
  }
  announce(runner);
  console.log(`[chat-runners] ${runner.name}: made in ${place.worktreePath} on ${place.branchName}, from ${start}`);
  return { runner };
}

/** The agents that run chats and hold a slot now: a live terminal, or a launch let through. */
function slotHolders(): Array<{ chat: Chat; agent: AgentStatus }> {
  const seen = new Set<string>();
  const out: Array<{ chat: Chat; agent: AgentStatus }> = [];
  for (const chat of store!.list().chats) {
    const agent = chat.runnerId ? agents.get(chat.runnerId) : undefined;
    if (!agent || seen.has(agent.id)) continue;
    if (!isLive(agent) && !reserved.has(agent.id)) continue;
    seen.add(agent.id);
    out.push({ chat, agent });
  }
  return out;
}

/** The chats that hold a slot now, for system:chatLimit. */
export function chatsWorking(): number {
  return store ? slotHolders().length : 0;
}

/** A slot for `forAgentId`, freed by a sleep when none is; or the refusal the user sees. */
async function freeSlot(forAgentId?: string): Promise<SendError | null> {
  const limit = chatLimitOf(os.totalmem(), process.env);
  const holders = slotHolders().filter(({ agent }) => agent.id !== forAgentId);
  if (holders.length < limit.limit) return null;
  const procs = await readProcesses();
  const now = Date.now();
  const candidates = holders.map(({ chat, agent }) => ({
    agentId: agent.id,
    isMain: chat.number === 1 || agent.kind !== 'chat',
    lastActivity: Date.parse(agent.lastActivity) || 0,
    refusal: reserved.has(agent.id) ? 'starting' : sleepRefusal(factsOf(agent, procs, now), { anyAge: true }),
  }));
  const victimId = victimOf(candidates);
  const victim = victimId ? agents.get(victimId) : undefined;
  // Read again with nothing awaited since, then put to sleep: a message on its
  // way to it is in its field (fieldInUse), and the sleep is synchronous up to
  // the end of its terminal's tree.
  if (victim && isLive(victim) && sleepRefusal(factsOf(victim, procs, Date.now()), { anyAge: true }) === null) {
    await sleepNow(victim, 'to free a slot for another chat');
    return null;
  }
  const working = holders.map(({ chat, agent }) => ({ chatId: chat.id, title: chat.title, since: agent.statusSince ?? agent.lastActivity }));
  return {
    error: 'chat_limit',
    reason: chatLimitSentence(limit.limit, limit.ramGb, limit.perChatGb, working.map((w) => w.title)),
    limit: limit.limit,
    ramGb: limit.ramGb,
    working,
  };
}

/**
 * The user's words into a chat's runner while its CLI runs: once a launch on
 * its way has taken keys (a message typed earlier is lost, #134), never into a
 * dialog (its Enter would answer it), and as the user's own, with no sender
 * line. Claude Code takes them during a turn too, in order.
 */
async function typeInto(runner: AgentStatus, chat: Chat, text: string): Promise<SendAnswer> {
  if (!(await sessionStarted(runner, SENDER_WAIT_MS))) {
    return failed(`${runner.name || 'Its agent'} is still starting: nothing was typed. Send it again in a moment.`);
  }
  const terminal = runner.ptyId ? ptyProcesses.get(runner.ptyId) : undefined;
  if (!terminal) return failed('Its terminal ended while the message waited: send it again.');
  if (dialogOpen(runner)) {
    return failed('Its CLI shows a dialog (a permission or a question), and a typed Enter would answer it: answer the dialog, then send again.');
  }
  const outcome = writeProgrammaticInput(terminal, text, true, { agentId: runner.id, from: 'you' });
  if (outcome === 'refused') return failed('Its terminal already holds as many messages as it can take: wait for it, and send again.');
  return { success: true, chatId: chat.id, runnerId: runner.id, how: outcome === 'held' ? 'held' : 'typed' };
}

/**
 * The user's words into a chat: typed into its runner's CLI when it runs, or
 * the prompt of a launch that resumes its conversation, within the limit.
 */
export async function sendToChat(chatId: unknown, text: unknown): Promise<SendAnswer> {
  if (!store) return { error: 'chats_unavailable', reason: 'The chats are not loaded yet.' };
  if (typeof text !== 'string' || !text.trim() || text.length > TEXT_MAX) {
    return { error: 'invalid_request', reason: `A message is text, 1 to ${TEXT_MAX} characters.` };
  }
  // Under the lock: whether a slot is needed, and the launch that takes it.
  // A runner that runs needs none, and is typed into outside the lock, so a
  // chat waiting on its starting CLI holds no other chat back.
  const decided = await withSlots(async (): Promise<SendAnswer | { typeInto: AgentStatus; chat: Chat }> => {
    const chat = store!.get(chatId);
    if (!chat) return { error: 'not_found', reason: 'No chat has this id.' };
    const lead = leadOf(chat.projectPath);
    let runner = chat.runnerId ? agents.get(chat.runnerId) : undefined;
    if (chat.runnerId && !runner) {
      return failed(chat.number === 1
        ? "This chat's orchestrator was deleted: set an orchestrator for the project on the Agents page."
        : "This chat's agent was deleted. Start a new chat.");
    }
    if (runner && isLive(runner)) return { typeInto: runner, chat };
    const full = diskRefusal(freeSpace());
    if (full) return { error: 'disk_full', reason: full };
    if (!runner) {
      if (!lead) return { error: 'no_orchestrator', reason: 'This project has no orchestrator: set one on the Agents page.' };
      if (getProvider(lead.provider).binaryName !== 'claude') {
        return { error: 'provider_unsupported', reason: "This project's orchestrator runs a CLI whose conversations Tars cannot resume: chats other than Main work with claude for now." };
      }
      const refused = await freeSlot();
      if (refused) return refused;
      const made = await makeRunner(chat, lead);
      if (!('runner' in made)) return made;
      runner = made.runner;
    } else {
      const refused = await freeSlot(runner.id);
      if (refused) return refused;
    }
    if (runner.kind === 'chat' && lead) {
      syncWithLead(runner, lead, chat);
      saveAgents();
    }
    // A chat's conversation goes on, whatever this run of Tars started before.
    resumeOnNextStart(runner.id);
    const note = notesForNextLaunch.get(runner.id);
    notesForNextLaunch.delete(runner.id);
    reserved.add(runner.id);
    try {
      const result = await launchAgent(runner.id, note ? `${note}\n\n${text}` : text);
      if (!result.success) return failed(result.error);
      return { success: true, chatId: chat.id, runnerId: runner.id, how: 'launched' };
    } finally {
      reserved.delete(runner.id);
    }
  });
  return 'typeInto' in decided ? typeInto(decided.typeInto, decided.chat, text) : decided;
}

/** Whether a chat may lose its runner: Main's is the orchestrator, never removed by a chat (4.1). */
function ownRunnerOf(chat: Chat): AgentStatus | undefined {
  const runner = chat.runnerId ? agents.get(chat.runnerId) : undefined;
  return runner?.kind === 'chat' && runner.chatId === chat.id ? runner : undefined;
}

/**
 * A deleted chat's runner: stopped, then removed with its worktree, its work
 * saved on wip/ first (#312, #335). The caller has checked the chat may go.
 */
export async function tearDownRunner(chat: Chat): Promise<{ savedTo?: string; worktreeKept?: string }> {
  const runner = ownRunnerOf(chat);
  if (!runner) return {};
  await stopAgent(runner, { by: 'you', reason: 'its chat was deleted' }, { save: saveAgents, announce });
  const removed = await removeAgent(runner.id);
  announce(runner);
  return { ...(removed.savedTo ? { savedTo: removed.savedTo } : {}), ...(removed.worktreeKept ? { worktreeKept: removed.worktreeKept } : {}) };
}

const settling = new Set<string>();

/** A settled chat's runner sleeps as soon as the rule allows it (its 30 minutes aside). */
async function sleepIfSettled(runnerId: string, triesLeft: number): Promise<void> {
  if (!store || settling.has(runnerId)) return;
  const runner = agents.get(runnerId);
  const chat = runner ? store.chatOfRunner(runner.id) : undefined;
  if (!runner || !chat || !chat.settledAt || runner.kind !== 'chat' || !isLive(runner)) return;
  settling.add(runnerId);
  try {
    const procs = await readProcesses();
    const why = isLive(runner) ? sleepRefusal(factsOf(runner, procs, Date.now()), { anyAge: true }) : 'no-cli';
    if (why === null) {
      await sleepNow(runner, 'its chat was settled');
      return;
    }
    if (triesLeft > 0 && why !== 'no-cli') {
      setTimeout(() => { void sleepIfSettled(runnerId, triesLeft - 1); }, SETTLE_RETRY_MS).unref?.();
    }
  } finally {
    settling.delete(runnerId);
  }
}

/** Settling a chat puts its runner to sleep at once, or as soon as it may; Main's never sleeps (4.2). */
export function settleRunner(chat: Chat): void {
  const runner = ownRunnerOf(chat);
  if (runner) void sleepIfSettled(runner.id, SETTLE_TRIES);
}

/** A renamed chat's runner is renamed with it: workers read the chat in its sender line. */
export function renameRunner(chat: Chat): void {
  const runner = ownRunnerOf(chat);
  if (!runner) return;
  const lead = leadOf(chat.projectPath);
  runner.name = runnerNameOf(lead?.name, chat.title);
  saveAgents();
  announce(runner);
}

/**
 * The orchestrator was saved (agent:update): each runner of its project takes
 * its configuration and name, and a live one is restarted on the launch
 * settings that changed, at a moment that cuts nothing (#120), in its own slot.
 */
export function restartRunnersOf(leadId: string, changed: string[]): void {
  if (!store) return;
  const lead = agents.get(leadId);
  if (!lead || lead.role !== 'orchestrator') return;
  for (const runner of agents.values()) {
    if (runner.kind !== 'chat' || runner.projectPath !== lead.projectPath) continue;
    const chat = runner.chatId ? store.get(runner.chatId) : undefined;
    if (!chat) continue;
    syncWithLead(runner, lead, chat);
    if (changed.length && isLive(runner)) restartForSettings(runner.id, changed);
  }
  saveAgents();
}

/**
 * At a launch after an abrupt stop: the runners that were working beyond what
 * the limit leaves, the least recently active, are not relaunched. They are
 * put asleep, their conversation kept, and their next launch opens with why.
 * Returns their ids, which crash-resume then leaves alone.
 */
export function leaveRunnersAsleep(working: Array<{ agentId: string }>, now = Date.now()): Set<string> {
  if (!store) return new Set();
  const limit = chatLimitOf(os.totalmem(), process.env);
  const runners = working.map((w) => agents.get(w.agentId)).filter((a): a is AgentStatus => !!a && a.kind === 'chat');
  // The others working that run a chat (Main's orchestrator) take their slot first.
  const mains = working.filter((w) => {
    const agent = agents.get(w.agentId);
    return !!agent && agent.kind !== 'chat' && !!store!.chatOfRunner(agent.id);
  }).length;
  const { leave } = runnersToResume(runners.map((r) => ({ agentId: r.id, lastActivity: Date.parse(r.lastActivity) || 0 })), limit.limit - mains);
  const stoppedAt = new Date(now).toTimeString().slice(0, 5);
  for (const id of leave) {
    const runner = agents.get(id)!;
    fallAsleep(runner, undefined, now);
    notesForNextLaunch.set(id, `[Tars] Tars stopped abruptly while this chat was working, and it was not restarted at launch (${stoppedAt}): `
      + `the limit is ${limit.limit} chats working at once. Your conversation is as it was; pick up where it stopped.`);
    console.log(`[chat-runners] ${runner.name}: not restarted at launch, the limit is ${limit.limit}; asleep`);
  }
  if (leave.length) saveAgents();
  return new Set(leave);
}

function onFleetChange(agentId: string): void {
  const agent = agents.get(agentId);
  if (agent?.kind === 'chat' && (agent.status === 'idle' || agent.status === 'completed')) void sleepIfSettled(agentId, 0);
}

/** Called once by handlers/chat-handlers.ts, with the store it made. */
export function startChatRunners(chatStore: ChatStore): void {
  if (store) return;
  store = chatStore;
  agentStatusEmitter.on('fleet-change', onFleetChange);
}
