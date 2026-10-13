'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FolderKanban } from 'lucide-react';
import { Button, PanelCaption } from '@/components/ui';
import { useElectronAgents } from '@/hooks/useElectron';
import { changeChat, isChatError, projectNameOf, useChats } from '@/hooks/useChats';
import type { ChatError } from '@/types/electron';

/**
 * New chat, as a record (`Shell · chats · new chat, its record`): the project,
 * the current one chosen and one without an orchestrator dimmed, and a title,
 * or New chat until its first message names it. The chat takes the project's
 * next number; its conversation opens with the next part of the preview.
 */
export function NewChatRecord({ initialProject }: { initialProject: string | null }) {
  const router = useRouter();
  const { agents } = useElectronAgents();
  const { chats } = useChats();
  const projects = useMemo(() => {
    const paths = new Set<string>();
    for (const agent of agents) if (agent.projectPath) paths.add(agent.projectPath);
    for (const chat of chats ?? []) paths.add(chat.projectPath);
    return Array.from(paths)
      .map(path => ({ path, name: projectNameOf(path), led: agents.some(a => a.role === 'orchestrator' && a.projectPath === path) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, chats]);
  const firstLed = projects.find(p => p.led)?.path ?? null;
  const [chosen, setChosen] = useState<string | null>(null);
  const project = chosen ?? (projects.some(p => p.path === initialProject && p.led) ? initialProject : firstLed);
  const [title, setTitle] = useState('');
  const [refused, setRefused] = useState<ChatError | null>(null);
  const [making, setMaking] = useState(false);

  const create = async () => {
    if (!project) return;
    setMaking(true);
    const answer = await changeChat(api => api.create({ projectPath: project, title: title.trim() || undefined }));
    setMaking(false);
    if (isChatError(answer)) {
      setRefused(answer);
      return;
    }
    router.push(`/chats?chat=${encodeURIComponent(answer.id)}`);
  };

  return (
    <div className="h-[calc(100vh-44px)] flex items-center justify-center">
      <div className="w-[720px] max-w-full flex flex-col gap-3.5 pb-20">
        <h1 className="font-serif text-[30px] leading-[1.1] text-foreground">New chat</h1>
        <p className="text-[13.5px] leading-[1.5] text-text-secondary">
          A conversation with the orchestrator of a project, on one topic. It takes the project&apos;s next number.
        </p>
        <div className="flex flex-col gap-3 p-3.5 bg-card border border-border-accent">
          <div className="flex items-center gap-2 flex-wrap">
            <PanelCaption>Project</PanelCaption>
            <div role="radiogroup" aria-label="Project" className="flex items-center gap-2 flex-wrap">
              {projects.map(p => {
                const on = p.path === project;
                return (
                  <button
                    key={p.path}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={p.name}
                    disabled={!p.led}
                    onClick={() => setChosen(p.path)}
                    className={`h-[22px] px-[7px] flex items-center gap-[5px] border disabled:opacity-40 disabled:cursor-not-allowed ${
                      on ? 'bg-accent-dim border-primary' : 'bg-card border-border'
                    }`}
                  >
                    <FolderKanban className={`w-[11px] h-[11px] ${on ? 'text-primary' : 'text-status-idle'}`} />
                    <span className={`font-mono text-[10.5px] ${on ? 'text-foreground' : 'text-text-secondary'}`}>{p.name}</span>
                    {!p.led && <span className="font-mono text-[10px] text-status-idle">no orchestrator</span>}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex items-center gap-2">
            <PanelCaption>Title</PanelCaption>
            <input
              aria-label="Title"
              value={title}
              onChange={event => setTitle(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void create(); }}
              placeholder="New chat, until its first message names it"
              className="flex-1 h-8 px-2.5 bg-secondary border border-border text-[13px] text-foreground placeholder:text-status-idle outline-none focus:border-border-accent"
            />
          </label>
          {refused && (
            <p role="alert" className="text-xs text-status-waiting">{refused.reason}</p>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs text-status-idle">Its conversation opens with the next part of this preview.</span>
            <span className="flex-1" />
            <Button variant="primary" disabled={!project || making} onClick={() => void create()}>Create chat</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
