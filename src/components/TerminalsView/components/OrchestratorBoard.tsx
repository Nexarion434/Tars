'use client';

import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { GRID_GAP, orchestratorBoxes } from '@/lib/orchestrator-board';

/**
 * The orchestrator layout (`Dashboard · orchestrator layout · 2 agents` to `· notes`): the orchestrator's card on the
 * left, two thirds of the board, and every other agent's in a column on the right that scrolls, each the card of today
 * as `panel` draws it. The column's cards keep the box a card of the 3x2 grid has (orchestratorBoxes), so the fit
 * addon gives their terminals the grid's columns and rows; a scrollbar that takes room, as Windows and Linux draw one,
 * is measured and taken from the orchestrator.
 */
function OrchestratorBoard({ width, height, orchestratorId, columnIds, panel }: {
  /** TerminalGrid's own box. */
  width: number;
  height: number;
  orchestratorId: string;
  /** Every other agent on the board, in its order. */
  columnIds: readonly string[];
  panel: (agentId: string) => ReactNode;
}) {
  const columnRef = useRef<HTMLDivElement>(null);
  const [scrollbar, setScrollbar] = useState(0);
  const boxes = orchestratorBoxes(width, height, columnIds.length, scrollbar);
  const hasColumn = boxes !== null;

  // The column's scrollbar: none where the system overlays it (macOS by default) or while its cards fit, its width where
  // it takes room. Read whenever the column's content box changes, which a scrollbar coming or going does, whatever
  // brought it: more cards, a shorter window, a stylesheet or a system setting. Read after each draw of the board only,
  // a scrollbar that came without one went unseen, and hid the right edge of every card.
  useLayoutEffect(() => {
    const column = columnRef.current;
    if (!column) return;
    const read = () => setScrollbar(column.offsetWidth - column.clientWidth);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(column);
    return () => observer.disconnect();
  }, [hasColumn]);

  if (!boxes) return null;
  return (
    <div className="flex" style={{ gap: GRID_GAP, height: boxes.boardHeight }}>
      <div className="shrink-0 overflow-hidden" style={{ width: boxes.orchestratorWidth, height: boxes.boardHeight }}>
        {panel(orchestratorId)}
      </div>
      <div
        ref={columnRef}
        data-board-column
        className="shrink-0 overflow-y-auto overflow-x-hidden"
        style={{ width: boxes.columnWidth, height: boxes.boardHeight }}
      >
        <div className="flex flex-col" style={{ gap: GRID_GAP, width: boxes.cardWidth }}>
          {columnIds.map((id) => (
            <div key={id} className="shrink-0 overflow-hidden" style={{ height: boxes.cardHeight }}>
              {panel(id)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default memo(OrchestratorBoard);
