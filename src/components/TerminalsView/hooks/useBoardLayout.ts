'use client';

import { useCallback, useState } from 'react';
import { BOARD_LAYOUT_KEY, boardLayoutOf, withBoardLayout, type BoardLayout } from '@/lib/orchestrator-board';

/**
 * A project's board layout, the orchestrator layout or the equal grid, kept per project in the window's storage
 * (`Dashboard · orchestrator layout · notes`). Read at the first render, since TerminalsView only renders in the
 * window: read once mounted, a project kept on the grid opened in the orchestrator layout first, and every terminal of
 * its board was built twice.
 */
export function useBoardLayout(projectPath: string | null) {
  const [stored, setStored] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(BOARD_LAYOUT_KEY);
    } catch {
      return null; // storage refused: every project in the orchestrator layout
    }
  });
  const pick = useCallback((layout: BoardLayout) => {
    if (!projectPath) return;
    const next = withBoardLayout(stored, projectPath, layout);
    setStored(next);
    try {
      window.localStorage.setItem(BOARD_LAYOUT_KEY, next);
    } catch {
      // kept while the window is open
    }
  }, [projectPath, stored]);
  const layout: BoardLayout = projectPath ? boardLayoutOf(stored, projectPath) : 'orchestrator';
  return { layout, pick };
}
