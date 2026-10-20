'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { PanelCaption } from '@/components/ui';
import type { ProjectFolder, ProjectPlace, VaultSub } from './useProjectFolders';

const SUBS: readonly VaultSub[] = ['reports', 'tools'];

const countOf = (n: ProjectFolder['reports']) => (typeof n === 'number' ? n : 0);

/** The projects' folders above the Vault's documents (frame `Vault · project folders · a report`, left column). */
export function ProjectFolders({ folders, place, onPick }: {
  folders: ProjectFolder[];
  place: ProjectPlace | null;
  onPick: (place: ProjectPlace) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <nav aria-label="Project folders" className="pb-2">
      <PanelCaption className="px-3 pt-3 pb-2">{`Projects · ${folders.length}`}</PanelCaption>
      {folders.length === 0 && (
        <p className="px-3 text-[11.5px] leading-[1.45] text-muted-foreground">
          No project folder yet. Each project gets one the first time an agent starts in it, with reports and tools: ~/.tars/project-files/&lt;project&gt;.
        </p>
      )}
      {folders.map((folder) => {
        const expanded = open.has(folder.key) || place?.key === folder.key;
        const Chevron = expanded ? ChevronDown : ChevronRight;
        return (
          <div key={folder.key}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => toggle(folder.key)}
              className="w-full h-[30px] flex items-center gap-2 px-3 text-left text-[12px] text-muted-foreground hover:text-foreground"
            >
              <Chevron className="w-3 h-3 shrink-0" />
              <span className="truncate flex-1 text-foreground">{folder.name}</span>
              {!expanded && <span className="font-mono text-[10.5px] text-muted-foreground">{countOf(folder.reports) + countOf(folder.tools)}</span>}
            </button>
            {expanded && SUBS.map((sub) => {
              const count = folder[sub];
              const active = place?.key === folder.key && place.sub === sub;
              const Icon = active ? FolderOpen : Folder;
              return (
                <button
                  key={sub}
                  type="button"
                  aria-pressed={active}
                  title={typeof count === 'number' ? undefined : count.error}
                  onClick={() => onPick({ key: folder.key, sub })}
                  className={`w-full h-[30px] flex items-center gap-2 pl-7 pr-3 text-left text-[12px] ${active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                >
                  <Icon className={`w-3 h-3 shrink-0 ${active ? 'text-primary' : ''}`} />
                  <span className="flex-1">{sub}</span>
                  <span className="font-mono text-[10.5px] text-muted-foreground">{typeof count === 'number' ? count : 'unreadable'}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
