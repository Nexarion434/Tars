'use client';

import { useEffect, useState } from 'react';
import { List } from 'lucide-react';
import { Button, StatusSquare } from '@/components/ui';
import type { AgentStatus } from '@/types/electron';
import { useTaskBanner } from '@/hooks/useTaskBanner';
import { cleanLine, clockOf, elapsedSince, sendersOf } from '@/lib/task-banner';

/**
 * The task an agent works on, above its terminal, wherever the terminal shows
 * (its Dashboard panel, its window): who gave it, since when and for how long,
 * its first line, the tasks waiting behind it, and stop task, which ends that
 * task only. Frames: `Task banner · above the agent's terminal` and its
 * Dashboard and window frames (design PR #451), whose panes give its widths:
 * from 560 px, "Task from <sender> since 14:02 · 4 min" and the waiting tasks'
 * senders beside their count; under 560, "from <sender> since 14:02", the
 * senders in their list only; under 400, the sender and the hour, and the
 * count without its icon.
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
          <span className="hidden @min-[560px]:inline">Task </span>
          <span className="hidden @min-[400px]:inline">from </span>
          <span className="text-foreground font-medium">{from}</span>
          <span className="font-mono">
            {' '}
            <span className="hidden @min-[400px]:inline">since </span>
            {clockOf(task.startedAt)}
            <span className="hidden @min-[560px]:inline"> · {elapsedSince(task.startedAt, now)}</span>
          </span>
        </p>
        <span className="flex-1" />
        {waiting.length > 0 && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={`h-[26px] shrink-0 flex items-center gap-1.5 px-2 border text-[11px] transition-colors ${open ? 'bg-card border-border-accent text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            <List size={12} className="hidden @min-[400px]:block" />
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
        <div className="absolute right-3 top-full z-20 mt-1 w-[320px] max-w-[calc(100%-24px)] bg-bg-elevated border border-border-accent">
          <div className="flex items-center justify-between px-3 pt-[9px] pb-[7px] text-[10px] text-muted-foreground">
            <span className="uppercase tracking-[0.08em]">Waiting · {waiting.length}</span>
            <span className="font-mono">in the order they run</span>
          </div>
          <ul aria-label="Tasks waiting">
            {waiting.map((w, i) => (
              <li key={w.ref} className="flex flex-col gap-[3px] px-3 py-2 border-t border-border">
                <p className="flex items-baseline gap-1.5 min-w-0">
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{i + 1}</span>
                  <span className="min-w-0 truncate text-[11.5px] text-foreground">from {cleanLine(w.from, 40)}</span>
                  <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">queued {clockOf(w.queuedAt)}</span>
                </p>
                <p className="truncate text-[12px] text-foreground">{cleanLine(w.firstLine, 100)}</p>
              </li>
            ))}
          </ul>
          <p className="px-3 pt-[7px] pb-[9px] border-t border-border font-mono text-[10.5px] text-muted-foreground">the first starts when this task ends</p>
        </div>
      )}
    </div>
  );
}
