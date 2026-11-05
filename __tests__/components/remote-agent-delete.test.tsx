import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentManagementCard } from '../../src/components/AgentList/AgentManagementCard';
import { remoteToAgent } from '../../src/lib/cloud';
import type { CloudRemoteAgent } from '../../src/types/electron';

/**
 * Delete on a server's agent, on its card in the Agents page (2026-11-05:
 * Nicolas found it greyed with no way to remove an agent made there). Written
 * before the code. How it can fail:
 * 1. greyed on a server that lets this computer create there, which is what
 *    deleting takes on the server;
 * 2. offered where the server does not (a device minted before `create`, or
 *    see and drive only), or while the server is not connected;
 * 3. greyed with no word of why, or with the generic "Read only" that says
 *    nothing of what would allow it;
 * 4. edit coming back with it: a server's agent is still not edited from here.
 */

function remote(server: Partial<CloudRemoteAgent['server']> = {}, status = 'idle'): CloudRemoteAgent {
  return {
    id: 'c:d795d0ff4d5d8e50:nova', agentId: 'nova', name: 'Nova', status, projectName: 'test', projectPath: '/home/tars/projects/test', cliRunning: false,
    server: { id: 's_1a2b3c4d', serverId: 'd795d0ff4d5d8e50', name: 'my-vps', status: 'connected', drive: true, ...server },
  };
}

const noop = () => {};
/** The card's button with this word, its attributes as rendered. */
function button(r: CloudRemoteAgent, word: string): string {
  const html = renderToStaticMarkup(
    <AgentManagementCard agent={remoteToAgent(r)} onClick={noop} onEdit={noop} onStart={noop} onStop={noop} onWake={noop} onDelete={noop} />,
  );
  const found = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].find(m => m[2] === word);
  if (!found) throw new Error(`no ${word} button in ${html}`);
  return found[1];
}

describe("Delete on a server's agent", () => {
  it('1. offered where the server lets this computer create, idle or at work (the server says when it will not)', () => {
    for (const status of ['idle', 'stopped', 'running']) {
      const attrs = button(remote({ create: true }, status), 'delete');
      expect(attrs, status).not.toMatch(/ disabled=""/);
      expect(attrs, status).not.toMatch(/title=/);
    }
  });

  it('2 and 3. greyed where the server does not let this computer create, saying how to allow it', () => {
    const attrs = button(remote({ drive: true }), 'delete');
    expect(attrs).toMatch(/ disabled=""/);
    expect(attrs).toContain('title="my-vps does not let this computer delete its agents: forget it in Settings &gt; Cloud, then connect again to allow it."');
  });

  it('2 and 3. greyed while the server is not connected, saying so', () => {
    for (const status of ['offline', 'disconnected'] as const) {
      const attrs = button(remote({ create: true, status }), 'delete');
      expect(attrs, status).toMatch(/ disabled=""/);
      expect(attrs, status).toContain('title="my-vps is not connected: its agents are deleted from here once it is."');
    }
  });

  it('4. edit stays greyed', () => {
    expect(button(remote({ create: true }), 'edit')).toMatch(/ disabled=""/);
  });
});
