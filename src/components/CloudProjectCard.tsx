'use client';

import type { MouseEvent } from 'react';
import { Button, CloudBadge } from '@/components/ui';
import type { CloudProjectRow } from '@/lib/cloud';

const ROW_ACTION = 'font-mono lowercase';

/**
 * A Tars server's project on the Projects page (M3). Frame: `Projects ·
 * with cloud`: the local card's shape, its server's badge beside its name,
 * its path from the server's home (~), and hide as its only action. Its
 * sessions are not on this computer (no open), and removing it would read
 * as deleting it on the server (no remove).
 */
export function CloudProjectCard({ row, hidden, onToggleHidden }: {
  row: CloudProjectRow;
  hidden: boolean;
  onToggleHidden(key: string, e: MouseEvent): void;
}) {
  return (
    <div data-cloud-project={row.key} className={`flex flex-col gap-2 border border-border bg-card p-3 transition-colors ${hidden ? 'opacity-50' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="min-w-0 flex items-center gap-1.5 text-[12.5px] text-foreground" title={row.name}>
          <span className="truncate">{row.name}</span>
          <CloudBadge name={row.server.name} />
        </h3>
        <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
          {row.agents === 1 ? '1 agent' : `${row.agents} agents`}
        </span>
      </div>
      <p className="truncate font-mono text-[10.5px] text-muted-foreground" title={row.path}>{row.shownPath}</p>
      <div className="flex items-center gap-2 pt-0.5">
        <Button size="sm" className={ROW_ACTION} onClick={e => onToggleHidden(row.key, e)}>
          {hidden ? 'unhide' : 'hide'}
        </Button>
      </div>
    </div>
  );
}
