import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GUIDE_TOPICS, TOOL_TOPIC, toolsNamedIn, guideIndex, guideTopic, identitySection,
} from '../../../electron/services/agent-guide';

/**
 * The guide every agent reads about Tars (services/agent-guide.ts), and the
 * section of its identity block written from it.
 *
 * How this can fail, written before the code:
 * 1. a bundled MCP server gains a tool and the guide never says what it is for:
 *    agents see a tool nobody explained (the kanban tools were in every CLI, and
 *    no agent had ever filed a task);
 * 2. the guide names a tool no server has (renamed, removed, misspelt): an agent
 *    calls it and fails;
 * 3. a tool points at a topic that does not exist;
 * 4. tars_guide itself is not in the guide;
 * 5. the identity section tells a worker what only an orchestrator can do
 *    (delegate_task, ask_user), or leaves an orchestrator without delegation and
 *    the way to follow a long run (task_status);
 * 6. the section grows past what every session can afford to carry (15 lines);
 * 7. the section does not name the agent's own project folder, or names a
 *    placeholder when there is one, or invents one when there is none;
 * 8. the section points at a topic tars_guide does not have;
 * 9. a topic is not stamped with the version of the Tars that answers, or an
 *    unknown topic answers something instead of nothing;
 * 10. an em or en dash reaches what agents read (CLAUDE.md, "No em dashes").
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** Every tool the bundled servers register, read from their sources as tools/list would give it. */
function serverTools(): Map<string, string> {
  const found = new Map<string, string>();
  const servers = fs.readdirSync(ROOT).filter(d => d.startsWith('mcp-') && d !== 'mcp-shared');
  const walk = (dir: string, server: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, server);
      else if (/\.ts$/.test(entry.name)) {
        const src = fs.readFileSync(p, 'utf8');
        // A row of a registerTools table, and the SDK's registerTool("name", ...).
        for (const m of src.matchAll(/^\s+name: "([a-z]+(?:_[a-z]+)*)",?\s*$/gm)) found.set(m[1], server);
        for (const m of src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)) found.set(m[1], server);
      }
    }
  };
  for (const server of servers) {
    const src = path.join(ROOT, server, 'src');
    if (fs.existsSync(src)) walk(src, server);
  }
  return found;
}

describe('the guide knows every tool an agent can see, and names no other', () => {
  const tools = serverTools();

  it('reads the servers it guards (a reader that finds nothing would pass anything)', () => {
    expect(tools.size).toBeGreaterThan(40);
    expect(tools.get('delegate_task')).toBe('mcp-orchestrator');
    expect(tools.get('create_task')).toBe('mcp-kanban');
    expect(tools.get('memory_search')).toBe('mcp-memory');
  });

  it('has a topic for every tool (1)', () => {
    const missing = [...tools.keys()].filter(t => !(t in TOOL_TOPIC));
    expect(missing).toEqual([]);
  });

  it('lists no tool that no server has (2)', () => {
    expect(Object.keys(TOOL_TOPIC).filter(t => !tools.has(t))).toEqual([]);
    const named = GUIDE_TOPICS.flatMap(t => toolsNamedIn(t.text));
    expect(named.length).toBeGreaterThan(20);
    expect([...new Set(named)].filter(t => !tools.has(t))).toEqual([]);
  });

  it('points every tool at a topic that exists (3), and has tars_guide (4)', () => {
    const ids = new Set(GUIDE_TOPICS.map(t => t.id));
    expect(Object.entries(TOOL_TOPIC).filter(([, topic]) => !ids.has(topic))).toEqual([]);
    expect(tools.get('tars_guide')).toBe('mcp-orchestrator');
    expect(ids.size).toBe(GUIDE_TOPICS.length);
  });
});

describe('the identity section, by role', () => {
  const folder = '/home/u/.dorothy/project-files/demo-0123456789';

  it('gives an orchestrator delegation, the long run and the user, and a worker none of it (5)', () => {
    const lead = identitySection('orchestrator', folder).join('\n');
    const worker = identitySection('worker', folder).join('\n');
    for (const word of ['delegate_task', 'task_status', 'create_task', 'ask_user', 'tars_guide']) expect(lead).toContain(word);
    for (const word of ['requester', 'assign_task', 'mark_task_done', 'create_task', 'tars_guide']) expect(worker).toContain(word);
    for (const word of ['delegate_task', 'ask_user', 'task_status']) expect(worker).not.toContain(word);
  });

  it('stays within 15 lines (6)', () => {
    expect(identitySection('orchestrator', folder).length).toBeLessThanOrEqual(15);
    expect(identitySection('worker', folder).length).toBeLessThanOrEqual(15);
  });

  it('names the project folder, and says so when there is none (7)', () => {
    expect(identitySection('worker', folder).join('\n')).toContain(folder);
    const none = identitySection('worker', null).join('\n');
    expect(none).not.toContain('project-files');
    expect(none).not.toMatch(/\{folder\}|null|undefined/);
  });

  it('points only at topics tars_guide has (8)', () => {
    const line = identitySection('worker', folder).find(l => l.includes('tars_guide'))!;
    const listed = line.split(':').slice(1).join(':').replace(/\.$/, '').split(',').map(s => s.trim());
    expect(listed.length).toBeGreaterThan(3);
    for (const id of listed) expect(guideTopic(id, '1.0.0', folder)).not.toBeNull();
  });
});

describe('tars_guide answers', () => {
  it('stamps the index and a topic with the version, and an unknown topic with nothing (9)', () => {
    expect(guideIndex('2.0.4')).toMatch(/^Tars 2\.0\.4/);
    for (const t of GUIDE_TOPICS) expect(guideIndex('2.0.4')).toContain(`- ${t.id}: `);
    const topic = guideTopic('project-folder', '2.0.4', '/x/.dorothy/project-files/demo-0123456789')!;
    expect(topic).toMatch(/^Tars 2\.0\.4, /);
    expect(topic).toContain('/x/.dorothy/project-files/demo-0123456789');
    expect(topic).not.toContain('{folder}');
    expect(guideTopic('KANBAN ', '2.0.4', null)).toContain('assign_task');
    expect(guideTopic('nope', '2.0.4', null)).toBeNull();
  });

  it('writes no em or en dash anywhere an agent reads it (10)', () => {
    const all = [
      ...GUIDE_TOPICS.flatMap(t => [t.title, t.text]),
      ...identitySection('orchestrator', '/f').concat(identitySection('worker', null)),
      guideIndex('2.0.4'),
    ].join('\n');
    expect(all).not.toMatch(/[–—]/);
  });
});
