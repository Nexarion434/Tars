'use client';

import { useEffect, useState } from 'react';
import { ListOrdered } from 'lucide-react';
import { Button, StatusSquare } from '@/components/ui';
import type { AgentStatus } from '@/types/electron';
import { useTaskBanner } from '@/hooks/useTaskBanner';
import { cleanLine, clockOf, elapsedSince, sendersOf } from '@/lib/task-banner';

/**
 * The task an agent works on, above its terminal, wherever the terminal shows
 * (its Dashboard panel, its window): who gave it, since when and for how long,
 * its first line, the tasks waiting behind it, and stop task, which ends that
 * task only. Frames: `Task banner · above the agent's terminal` and its
 * Dashboard and window frames (design PR #451). Narrower than 400 px it keeps
 * the sender and the hour; under 560 px the waiting tasks' senders move into
 * their list.
 */
export default function TaskBanner({ agent }: { agent: AgentStatus }) {
  const banner = useTaskBanner(agent);
  const task = banner?.task ?? null;
  const waiting = banner?.waiting ?? [];
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!task) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [task]);
  useEffect(() => { setError(null); }, [task?.ref]);
  useEffect(() => { if (waiting.length === 0) setOpen(false); }, [waiting.length]);

  if (!task) return null;
  const from = cleanLine(task.from, 40);
  const firstLine = cleanLine(task.firstLine, 100);

  const stop = async () => {
    setStopping(true);
    setError(null);
    try {
      const result = await window.electronAPI?.agent?.stopTask?.(agent.id, task.ref);
      if (result && !result.success) setError(result.error || 'This task could not be stopped.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  return (
    <div
      data-task-banner
      role="status"
      aria-label={`Task from ${from}`}
      className="@container relative shrink-0 px-3 py-1.5 bg-secondary border-b border-border select-none"
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusSquare tone="running" />
        <p className="min-w-0 truncate text-[11px] leading-tight text-muted-foreground">
          <span className="hidden @min-[400px]:inline">Task from </span>
          <span className="text-foreground font-medium">{from}</span>
          <span className="font-mono">
            {' '}
            <span className="hidden @min-[400px]:inline">since </span>
            {clockOf(task.startedAt)}
            <span className="hidden @min-[400px]:inline"> · {elapsedSince(task.startedAt, now)}</span>
          </span>
        </p>
        <span className="flex-1" />
        {waiting.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={`h-[26px] shrink-0 flex items-center gap-1.5 px-2 border text-[11px] transition-colors ${open ? 'bg-background border-border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            <ListOrdered size={12} />
            <span>{waiting.length} waiting</span>
            <span className="hidden @min-[560px]:inline">· {sendersOf(waiting)}</span>
          </button>
        )}
        <Button size="sm" className="font-mono shrink-0" onClick={stop} disabled={stopping}>
          stop task
        </Button>
      </div>
      <p className="mt-1 truncate text-[12px] leading-snug text-foreground" title={firstLine}>{firstLine}</p>
      {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
      {open && waiting.length > 0 && (
        <div className="absolute right-3 top-full z-20 mt-1 w-[300px] max-w-[calc(100%-24px)] p-2 bg-secondary border border-border-accent">
          <div className="flex items-center justify-between px-1 pb-1 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            <span>Waiting · {waiting.length}</span>
            <span className="normal-case tracking-normal">in the order they run</span>
          </div>
          <ul aria-label="Tasks waiting" className="flex flex-col gap-1">
            {waiting.map((w) => (
              <li key={w.ref} className="px-1 py-1">
                <p className="text-[11px] text-muted-foreground">
                  from <span className="text-foreground">{cleanLine(w.from, 40)}</span>
                  <span className="font-mono"> queued {clockOf(w.queuedAt)}</span>
                </p>
                <p className="truncate text-[12px] text-foreground">{cleanLine(w.firstLine, 100)}</p>
              </li>
            ))}
          </ul>
          <p className="px-1 pt-1 text-[11px] text-muted-foreground">The first starts when this task ends.</p>
        </div>
      )}
    </div>
  );
}
