/**
 * The Dashboard's orchestrator layout (t-c4ac3055, the maintainer's idea of 18/10): on a project's board that holds
 * its orchestrator and another agent, the orchestrator's card takes the left two thirds of the board, two columns and
 * both rows of the 3x2 grid, and every other agent a card of that grid in a column on the right, which scrolls.
 * Frames `Dashboard · orchestrator layout · 2 agents` to `· notes`. Pure, so the board draws it and the tests read it.
 */

/** TerminalGrid's grid: 8 between its cards, none around them, a row at least 80 high. */
export const GRID_GAP = 8;
export const GRID_MIN_ROW = 80;

/**
 * The orchestrator of a board the layout is for, or null: a project's board (a custom tab keeps its own preset), two
 * agents on it at least, and one of them the orchestrator. Of two orchestrators, the first in the board's order.
 */
export function boardOrchestrator(agents: ReadonlyArray<{ id: string; role?: string | null }>, isProjectBoard: boolean): string | null {
  if (!isProjectBoard || agents.length < 2) return null;
  return agents.find((a) => a.role === 'orchestrator')?.id ?? null;
}

export type BoardLayout = 'orchestrator' | 'grid';

/**
 * Where each project's choice is kept in the window's storage: `{ "<project path>": "grid" }`. A project never switched
 * is in the orchestrator layout, so that choice is never written.
 */
export const BOARD_LAYOUT_KEY = 'tars-dashboard-board-layout';

/** The choices as stored, in a Map: a path named `__proto__` or `constructor` is a key like any other. */
function choices(stored: string | null | undefined): Map<string, unknown> {
  if (typeof stored !== 'string') return new Map();
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

/** A project's layout: the grid where 'grid' was picked for it, the orchestrator layout otherwise. */
export function boardLayoutOf(stored: string | null | undefined, projectPath: string): BoardLayout {
  return choices(stored).get(projectPath) === 'grid' ? 'grid' : 'orchestrator';
}

/** The storage with a project's choice in it, every other project's kept; anything not this one's own is dropped. */
export function withBoardLayout(stored: string | null | undefined, projectPath: string, layout: BoardLayout): string {
  const next = choices(stored);
  for (const [path, value] of next) if (value !== 'grid') next.delete(path);
  if (layout === 'grid') next.set(projectPath, 'grid');
  else next.delete(projectPath);
  return JSON.stringify(Object.fromEntries(next));
}

export interface OrchestratorBoxes {
  /** The orchestrator's card: two columns of the grid and the gap, less a scrollbar that takes room. */
  orchestratorWidth: number;
  /** The column: a card's width, and its scrollbar's. */
  columnWidth: number;
  /** A card of the column: a column of the grid. */
  cardWidth: number;
  /** A row of the 3x2 grid, or the board's height for the one card of a board of two. */
  cardHeight: number;
  /** Two rows of the 3x2 grid and the gap between them: the orchestrator's height and the column's. */
  boardHeight: number;
}

/**
 * The layout's boxes in a board `width` by `height` (TerminalGrid's own box), `others` agents in the column and its
 * scrollbar `scrollbar` wide where the system draws one that takes room: the column's cards keep the box a card of the
 * 3x2 grid has, so their terminals keep its columns and rows, and the scrollbar's room comes from the orchestrator.
 * Null for a board not measured yet or a column with nobody in it.
 */
export function orchestratorBoxes(width: number, height: number, others: number, scrollbar: number): OrchestratorBoxes | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !(others >= 1)) return null;
  const bar = Number.isFinite(scrollbar) && scrollbar > 0 ? scrollbar : 0;
  const cardWidth = (width - GRID_GAP * 2) / 3;
  const rowHeight = Math.max(GRID_MIN_ROW, (height - GRID_GAP * 3) / 2);
  const boardHeight = rowHeight * 2 + GRID_GAP;
  return {
    orchestratorWidth: width - GRID_GAP - cardWidth - bar,
    columnWidth: cardWidth + bar,
    cardWidth,
    cardHeight: others === 1 ? boardHeight : rowHeight,
    boardHeight,
  };
}
