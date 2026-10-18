/**
 * Where the boxes of Brain's agent graph go, and how much of the graph its
 * canvas shows (JeanBrasse, 18/10, for 2.0.4). Frames: `Brain · Agents`, and
 * `Brain · Agents · fifty agents, fitted`. Its failures are listed, and
 * pinned, in __tests__/lib/graph-layout.test.ts.
 *
 * The rings stay: the projects in the middle, their agents around them, the
 * files the agents read next, the tools they share outside. A ring used to be
 * one circle just wide enough for its boxes, so the drawing's width followed
 * the count of a ring and its area the square of it: the 997 memory files of
 * the maintainer's fifty agents drew a ring 65,000 px wide, and a fixed floor
 * of 25 % left the canvas a sixth of it. A ring is now a band of boxes laid
 * like bricks, rows of them, around the ring inside it: as many as its count
 * needs, going round clockwise from the top in the order given, so the area
 * follows the count and the width its square root.
 */

export const BOX_W = 176;
export const BOX_H = 46;
/** A box and the 28 px around it: the pitch of the bricks, so two boxes never touch. */
const PITCH_X = BOX_W + 28;
const PITCH_Y = BOX_H + 28;
/** At least this far from the middle of the outermost box of a ring to the middle of a box of the next. */
export const RING_GAP = 132;
/** The room left beside the graph when it is fitted to its canvas, left and right. */
export const FIT_MARGIN = 24;

export interface Margins { top: number; right: number; bottom: number; left: number }

/**
 * The room kept round the graph at fit. Above and below, it is kept clear of
 * what the canvas draws over the graph: the zoom controls in its top right
 * corner (8 px down, 36 px tall) and the legend in its bottom left one (12 px
 * up, two 11 px lines), with 8 px to spare. The bands run the canvas's whole
 * width, so no box goes under either wherever it sits: with tight bounds and
 * rings that start at the top, a small graph put boxes in those corners (the
 * QA's L1 at the gate of #454).
 */
export const GRAPH_MARGINS: Margins = { top: 52, right: FIT_MARGIN, bottom: 56, left: FIT_MARGIN };
/** The zoom goes down to 25 %, or to the fit when the whole graph needs less. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;

export interface Point { x: number; y: number }

export interface Layout {
  /** The middle of each box, from the drawing's top-left corner. */
  positions: Map<string, Point>;
  /** The drawing's bounds: the boxes and nothing more. */
  width: number;
  height: number;
  /** The point the rings go round, in the same frame. */
  centre: Point;
}

type Cell = Point & { r: number; a: number };

/** Round the middle, clockwise from the top, in [0, 2π). */
function angleOf(x: number, y: number): number {
  const a = Math.atan2(x, -y);
  return a < 0 ? a + 2 * Math.PI : a;
}

/** The bricks from `from` to `to` out of the middle: rows PITCH_Y apart, every other row shifted half a brick. */
function bricks(from: number, to: number): Cell[] {
  const cells: Cell[] = [];
  const rows = Math.floor(to / PITCH_Y);
  const columns = Math.ceil(to / PITCH_X) + 1;
  for (let j = -rows; j <= rows; j++) {
    const y = j * PITCH_Y;
    const shift = Math.abs(j) % 2 === 1 ? PITCH_X / 2 : 0;
    for (let i = -columns; i <= columns; i++) {
      const x = i * PITCH_X + shift;
      const r = Math.hypot(x, y);
      if (r >= from && r <= to) cells.push({ x, y, r, a: angleOf(x, y) });
    }
  }
  return cells;
}

/**
 * The bricks a ring of `count` boxes takes, `from` the middle out: the band
 * just deep enough to hold them, and of its bricks `count` taken evenly round
 * it, in the order they go round, the first at the top. Every ring starts
 * there, so a lone skill sits by the first agent that reads it, not across
 * the graph from it.
 */
function band(count: number, from: number): Cell[] {
  // Room for the count and a row more, then wider until it holds them: the
  // first guess holds them but on a shape that is no circle.
  let to = Math.sqrt(from * from + (count * PITCH_X * PITCH_Y) / Math.PI) + PITCH_X;
  let cells = bricks(from, to);
  while (cells.length < count) {
    to += PITCH_X;
    cells = bricks(from, to);
  }
  cells.sort((p, q) => p.r - q.r || p.a - q.a || p.x - q.x || p.y - q.y);
  const reach = cells[count - 1].r;
  const held = cells.filter(c => c.r <= reach).sort((p, q) => p.a - q.a || p.r - q.r || p.x - q.x || p.y - q.y);
  return Array.from({ length: count }, (_, i) => held[Math.floor((i * held.length) / count)]);
}

export interface RingNode { id: string; ring: number; label: string }

/**
 * The nodes of each ring in the order they go round it. The middle as given;
 * the agents together by their project's place in the middle, as given
 * within a project; a file or a tool beside the first agent that reads it, by
 * name beside the same agent, one no agent reads last. Each node's owner is
 * read once from the edges, not again for every comparison of the sort.
 */
export function ringOrder(nodes: RingNode[], edges: Array<{ source: string; target: string }>): string[][] {
  const rings: RingNode[][] = [];
  for (const node of nodes) (rings[node.ring] ??= []).push(node);
  for (let r = 0; r < rings.length; r++) rings[r] ??= [];
  if (rings.length === 0) return [];
  const ringOf = new Map(nodes.map(n => [n.id, n.ring]));
  const given = new Map(nodes.map((n, i) => [n.id, i]));
  /** The lowest place, in ring `of`, of a node linked to each node of ring `ring`. */
  const owners = (ring: number, of: number, place: Map<string, number>) => {
    const owner = new Map<string, number>();
    for (const { source, target } of edges) {
      for (const [mine, theirs] of [[source, target], [target, source]]) {
        if (ringOf.get(mine) !== ring || ringOf.get(theirs) !== of) continue;
        const rank = place.get(theirs);
        if (rank !== undefined && rank < (owner.get(mine) ?? Infinity)) owner.set(mine, rank);
      }
    }
    return owner;
  };
  const placeOf = (ring: RingNode[]) => new Map(ring.map((n, i) => [n.id, i]));
  const projectOf = owners(1, 0, placeOf(rings[0]));
  const agents = [...(rings[1] ?? [])].sort((a, b) =>
    (projectOf.get(a.id) ?? Infinity) - (projectOf.get(b.id) ?? Infinity) || given.get(a.id)! - given.get(b.id)!);
  const agentPlace = placeOf(agents);
  return rings.map((ring, r) => {
    if (r === 0) return ring.map(n => n.id);
    if (r === 1) return agents.map(n => n.id);
    const agentOf = owners(r, 1, agentPlace);
    return [...ring].sort((a, b) => (agentOf.get(a.id) ?? Infinity) - (agentOf.get(b.id) ?? Infinity)
      || a.label.localeCompare(b.label) || a.id.localeCompare(b.id)).map(n => n.id);
  });
}

/**
 * Places the nodes of each ring, from the middle out: a lone node of the
 * first ring with any in the middle itself, several around it, each next
 * ring a band at least RING_GAP beyond the ring inside it. An empty ring is
 * skipped.
 */
export function layoutRings(rings: string[][]): Layout {
  const placed: Array<{ id: string; cell: Cell }> = [];
  let reach = -1;
  for (const ring of rings) {
    if (ring.length === 0) continue;
    const from = reach >= 0 ? reach + RING_GAP : ring.length === 1 ? 0 : 1;
    const cells = band(ring.length, from);
    ring.forEach((id, i) => placed.push({ id, cell: cells[i] }));
    reach = Math.max(...cells.map(c => c.r));
  }
  if (placed.length === 0) return { positions: new Map(), width: 0, height: 0, centre: { x: 0, y: 0 } };
  const left = Math.min(...placed.map(p => p.cell.x)) - BOX_W / 2;
  const top = Math.min(...placed.map(p => p.cell.y)) - BOX_H / 2;
  const right = Math.max(...placed.map(p => p.cell.x)) + BOX_W / 2;
  const bottom = Math.max(...placed.map(p => p.cell.y)) + BOX_H / 2;
  return {
    positions: new Map(placed.map(p => [p.id, { x: p.cell.x - left, y: p.cell.y - top }])),
    width: right - left,
    height: bottom - top,
    centre: { x: -left, y: -top },
  };
}

type Size = { width: number; height: number };

/**
 * The zoom at which the whole graph fits the canvas within its margins, never
 * above 100 %: a small graph is drawn at its size, a large one as large as
 * the canvas takes. Null while the canvas has no room (a tab not shown yet),
 * so the zoom stays as it is.
 */
export function fitZoom(graph: Size, view: Size, margins: Margins = GRAPH_MARGINS): number | null {
  const roomW = view.width - margins.left - margins.right;
  const roomH = view.height - margins.top - margins.bottom;
  if (!(roomW > 0 && roomH > 0)) return null;
  if (!(graph.width > 0 && graph.height > 0)) return 1;
  return Math.min(1, roomW / graph.width, roomH / graph.height);
}

/** The zoom's range: down to 25 %, or to the fit when the whole graph needs less, and up to 200 %. */
export function zoomBounds(fit: number | null): { min: number; max: number } {
  return { min: fit === null ? ZOOM_MIN : Math.min(ZOOM_MIN, fit), max: ZOOM_MAX };
}

export interface StageBox { width: number; height: number; left: number; top: number }

/**
 * What the canvas scrolls over at a zoom: the graph and its margins, at least
 * the canvas itself, and where the graph's corner sits on it. A graph smaller
 * than the canvas is centred between its margins; a larger one starts at
 * them, never at a negative offset, so its left and top can be scrolled to.
 */
export function stageBox(graph: Size, view: Size, zoom: number, margins: Margins = GRAPH_MARGINS): StageBox {
  const w = graph.width * zoom;
  const h = graph.height * zoom;
  const width = Math.max(view.width, w + margins.left + margins.right);
  const height = Math.max(view.height, h + margins.top + margins.bottom);
  return {
    width,
    height,
    left: margins.left + (width - margins.left - margins.right - w) / 2,
    top: margins.top + (height - margins.top - margins.bottom - h) / 2,
  };
}

/**
 * The scroll that keeps the graph's point under `anchor` (in the canvas)
 * where it was, from one zoom to another, within the stage's ends.
 */
export function keepAnchor(
  anchor: Point,
  scroll: { left: number; top: number },
  view: Size,
  from: { zoom: number; box: StageBox },
  to: { zoom: number; box: StageBox },
): { left: number; top: number } {
  const gx = (scroll.left + anchor.x - from.box.left) / from.zoom;
  const gy = (scroll.top + anchor.y - from.box.top) / from.zoom;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), Math.max(max, 0));
  return {
    left: clamp(to.box.left + gx * to.zoom - anchor.x, to.box.width - view.width),
    top: clamp(to.box.top + gy * to.zoom - anchor.y, to.box.height - view.height),
  };
}
