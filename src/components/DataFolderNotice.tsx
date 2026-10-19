'use client';

import { useEffect, useState } from 'react';
import { dataFolderNotice } from '@/lib/data-folder-notice';

/**
 * The line across the top of the main column when Tars could not settle on ~/.tars (2.0.4, #473's app:dataDir;
 * frame `Data folder · notice`): two data folders and the one Tars runs on, or a move refused and the folder it goes
 * on from. Read once as the shell opens; dismiss hides it until Tars starts again. The line of the panels' notices.
 */
export function DataFolderNotice({ className = '' }: { className?: string }) {
  const [said, setSaid] = useState<{ dir: string; rest: string } | null>(null);
  useEffect(() => {
    let live = true;
    window.electronAPI?.app?.dataDir?.()
      .then((answer) => {
        const rest = dataFolderNotice(answer);
        if (live && rest) setSaid({ dir: answer.dir, rest });
      })
      .catch(() => { /* an older main without the channel: no line */ });
    return () => { live = false; };
  }, []);

  if (!said) return null;
  return (
    <div role="status" aria-label="Data folder" className={`flex items-center gap-2 h-[26px] pl-3 pr-1 bg-secondary border-b border-border overflow-hidden ${className}`}>
      <span className="w-1.5 h-1.5 shrink-0 bg-warning" />
      <p className="flex-1 min-w-0 flex items-center gap-[5px] text-[11px] leading-[1.4] truncate" title={said.rest}>
        <span className="text-foreground shrink-0">Data folder:</span>
        <span className="text-text-secondary truncate">{said.rest}</span>
      </p>
      <button
        type="button"
        onClick={() => { void window.electronAPI?.shell?.reveal(said.dir); }}
        className="h-[26px] px-2.5 font-mono text-[12px] font-medium text-text-secondary hover:text-foreground"
      >
        show folder
      </button>
      <button
        type="button"
        onClick={() => setSaid(null)}
        className="h-[26px] px-2.5 font-mono text-[12px] font-medium text-text-secondary hover:text-foreground"
      >
        dismiss
      </button>
    </div>
  );
}
