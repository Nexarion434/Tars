'use client';

import { File, FileCode, FileText } from 'lucide-react';
import { BrandSpinner, Button, PanelCaption, StatusSquare } from '@/components/ui';
import { listTime } from './file-words';
import type { ProjectFileList as Listed, ProjectFolder, VaultSub } from './useProjectFolders';

const ICONS = { markdown: FileText, text: FileText, code: FileCode, other: File } as const;

/** A project's reports or tools, newest first (frame `Vault · project folders · a report`, middle column). */
export function ProjectFileList({ folder, sub, list, selected, notesMoved, onOpen, onShowFolder }: {
  folder: ProjectFolder;
  sub: VaultSub;
  list: Listed | null;
  selected: string | null;
  /** Where its notes went in 2.0.4 (reports/notes), said under its reports. */
  notesMoved?: string;
  onOpen: (name: string) => void;
  onShowFolder: () => void;
}) {
  const files = list && 'files' in list ? list.files : [];
  const count = files.length + (list && 'files' in list ? list.more ?? 0 : 0);
  const folderPath = `~/.dorothy/project-files/${folder.key}/${sub}`;
  const notesName = notesMoved ? notesMoved.split(/[\\/]/).filter(Boolean).pop() : undefined;

  return (
    <section aria-label="Files" className="flex flex-col h-full min-h-0 p-3.5 gap-1.5">
      <div className="flex items-center justify-between gap-2 pb-0.5">
        <PanelCaption>{`${folder.name} · ${sub} · ${count} ${count === 1 ? 'file' : 'files'}`.toUpperCase()}</PanelCaption>
        <span className="font-mono text-[10.5px] text-muted-foreground">newest first</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {list === null ? (
          <div className="flex items-center justify-center py-8"><BrandSpinner size={24} label={`Reading ${sub}`} /></div>
        ) : 'error' in list ? (
          <p className="text-[11.5px] text-danger">{`Could not read ${sub}: ${list.error}`}</p>
        ) : files.length === 0 ? (
          <p className="text-[11.5px] leading-[1.45] text-muted-foreground">
            {sub === 'reports'
              ? `No report yet. The agents of ${folder.name} write theirs in ${folderPath}, and each shows here as it is written.`
              : `No tool yet. The agents of ${folder.name} keep theirs in ${folderPath}, and each shows here as it is written.`}
          </p>
        ) : (
          <>
            {files.map((file) => {
              const Icon = ICONS[file.kind];
              const active = file.name === selected;
              return (
                <button
                  key={file.name}
                  type="button"
                  data-file-name={file.name}
                  aria-pressed={active}
                  onClick={() => onOpen(file.name)}
                  className={`w-full flex items-center gap-2 px-2.5 py-[7px] text-left ${active ? 'bg-secondary' : 'hover:bg-secondary/60'}`}
                >
                  <Icon className={`w-3 h-3 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className={`font-mono text-[11.5px] truncate ${active ? 'text-foreground' : 'text-muted-foreground'}`}>{file.name}</span>
                  <span className="flex-1" />
                  <span className="w-[76px] shrink-0 text-right font-mono text-[10.5px] text-muted-foreground">{listTime(file.mtimeMs)}</span>
                </button>
              );
            })}
            {'more' in list && list.more ? (
              <p className="px-2.5 py-2 text-[11px] text-muted-foreground">{`And ${list.more} more, not listed: the list stops at 1,000.`}</p>
            ) : null}
          </>
        )}
      </div>

      {sub === 'reports' && notesName && (
        <div className="flex items-center gap-2.5 px-2.5 py-2 bg-secondary border border-border">
          <StatusSquare tone="idle" />
          <p className="flex-1 text-[11.5px] leading-[1.45] text-muted-foreground">{`Its notes are in reports/${notesName} since 2.0.4, and are not listed here.`}</p>
          <Button size="sm" className="font-mono" onClick={onShowFolder}>show notes</Button>
        </div>
      )}

      <div className="flex items-center gap-2 pt-2 border-t border-border">
        <span className="flex-1 min-w-0 font-mono text-[10.5px] text-muted-foreground break-all">{folderPath}</span>
        <Button size="sm" className="font-mono" onClick={onShowFolder}>show folder</Button>
      </div>
    </section>
  );
}
