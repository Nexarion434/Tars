import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every New agent in the window offers the same projects: this computer's and
 * each connected server's (Nicolas's real test of 2026-11-04: a server's
 * project made, then New agent opened from the Agents page did not offer it,
 * because only the Projects page built that list). Written before the fix.
 * How it fails:
 * 1. a page opens New agent with a list of its own, without the servers'
 *    projects (`newAgentProjects`)
 * 2. that page's submit does not send a server's project to its server
 *    (`createOnServer`), so the agent would be made on this computer
 * 3. an agent's settings (the edit modal) offer a server's project: an agent
 *    of this computer cannot move to a server (Move to cloud is M4)
 */

const SRC = path.join(__dirname, '..', '..', 'src');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx$/.test(e.name) ? [p] : [];
  });
}

/** Each `<NewChatModal ... />` element in the window's sources, with its file. */
const modals = sources(SRC).flatMap(file => {
  const text = fs.readFileSync(file, 'utf8');
  const found: Array<{ file: string; element: string; text: string }> = [];
  let at = text.indexOf('<NewChatModal');
  while (at !== -1) {
    found.push({ file: path.relative(SRC, file), element: text.slice(at, text.indexOf('/>', at) + 2), text });
    at = text.indexOf('<NewChatModal', at + 1);
  }
  return found;
});

describe('New agent\'s projects on every page', () => {
  it('finds the pages that open New agent', () => {
    expect(modals.map(m => m.file).sort()).toEqual([
      path.join('app', 'agents', 'page.tsx'),
      path.join('app', 'agents', 'page.tsx'),
      path.join('app', 'projects', 'page.tsx'),
      path.join('components', 'TerminalsView', 'index.tsx'),
    ]);
  });

  it('1, 2. every New agent lists the servers\' projects, and its page makes theirs on the server', () => {
    for (const m of modals.filter(m => !m.element.includes('editAgent='))) {
      expect(m.element, m.file).toMatch(/projects=\{newAgentProjects\(/);
      expect(m.text, m.file).toMatch(/createOnServer\(/);
    }
  });

  it('3. an agent\'s settings offer this computer\'s projects only', () => {
    const edits = modals.filter(m => m.element.includes('editAgent='));
    expect(edits.length).toBeGreaterThan(0);
    for (const m of edits) expect(m.element, m.file).not.toMatch(/newAgentProjects/);
  });
});
