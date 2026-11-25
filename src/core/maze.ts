import type { Config } from './config';
import type { Rng } from './rng';
import type { Barrier, Maze, MazeCell } from './types';

/**
 * The maze: the arena is a grid of cells and walls sit on the lines between cells.
 *
 * generateMaze() starts from a "perfect" maze (every cell reachable by exactly one route),
 * knocks out a share of the remaining walls so there are loops, and finally opens a wall in
 * every dead end. So every cell can always be reached from every other cell, and nobody can
 * be cornered in a dead end.
 */

type Side = 'n' | 'e' | 's' | 'w';
const SIDES: Side[] = ['n', 'e', 's', 'w'];
const STEP: Record<Side, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },
  e: { dx: 1, dy: 0 },
  s: { dx: 0, dy: 1 },
  w: { dx: -1, dy: 0 },
};
const OPPOSITE: Record<Side, Side> = { n: 's', e: 'w', s: 'n', w: 'e' };

export interface Cell {
  col: number;
  row: number;
}

/** Removes the wall between a cell and its neighbour on the given side. */
function openWall(maze: Maze, col: number, row: number, side: Side): void {
  const next = STEP[side];
  maze.cells[row][col][side] = false;
  maze.cells[row + next.dy][col + next.dx][OPPOSITE[side]] = false;
}

function inside(maze: Maze, col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < maze.cols && row < maze.rows;
}

/** Builds a new random maze. Same rng state gives the same maze. */
export function generateMaze(rng: Rng, cfg: Config, openChance: number): Maze {
  const { cols, rows } = cfg.maze;
  const cells: MazeCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ n: true, e: true, s: true, w: true })),
  );
  const maze: Maze = { cols, rows, cells };

  // 1. A perfect maze by depth-first carving.
  const seen = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const start = { col: rng.int(0, cols - 1), row: rng.int(0, rows - 1) };
  seen[start.row][start.col] = true;
  const stack: Cell[] = [start];
  while (stack.length > 0) {
    const here = stack[stack.length - 1];
    const options = SIDES.filter((s) => {
      const c = here.col + STEP[s].dx;
      const r = here.row + STEP[s].dy;
      return inside(maze, c, r) && !seen[r][c];
    });
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const side = options[rng.int(0, options.length - 1)];
    openWall(maze, here.col, here.row, side);
    const next = { col: here.col + STEP[side].dx, row: here.row + STEP[side].dy };
    seen[next.row][next.col] = true;
    stack.push(next);
  }

  // 2. Loops: knock out a share of the walls that are left.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (col < cols - 1 && cells[row][col].e && rng.next() < openChance) openWall(maze, col, row, 'e');
      if (row < rows - 1 && cells[row][col].s && rng.next() < openChance) openWall(maze, col, row, 's');
    }
  }

  // 3. No dead ends: any cell with only one opening gets a second one.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = cells[row][col];
      const walls = SIDES.filter((s) => cell[s]);
      if (walls.length < 3) continue;
      const openable = walls.filter((s) => inside(maze, col + STEP[s].dx, row + STEP[s].dy));
      if (openable.length > 0) openWall(maze, col, row, openable[rng.int(0, openable.length - 1)]);
    }
  }

  return maze;
}

/** How wide and tall one cell is, in pixels. */
export function cellSize(cfg: Config): { width: number; height: number } {
  return { width: cfg.arena.width / cfg.maze.cols, height: cfg.arena.height / cfg.maze.rows };
}

/** The pixel position of the middle of a cell. Corridors are centred on these points. */
export function cellCenter(cfg: Config, col: number, row: number): { x: number; y: number } {
  const size = cellSize(cfg);
  return { x: cfg.arena.x + (col + 0.5) * size.width, y: cfg.arena.y + (row + 0.5) * size.height };
}

/** Which cell a pixel position is in (clamped to the grid). */
export function cellOf(cfg: Config, x: number, y: number): Cell {
  const size = cellSize(cfg);
  const col = Math.floor((x - cfg.arena.x) / size.width);
  const row = Math.floor((y - cfg.arena.y) / size.height);
  return {
    col: Math.min(cfg.maze.cols - 1, Math.max(0, col)),
    row: Math.min(cfg.maze.rows - 1, Math.max(0, row)),
  };
}

/** The cells you can walk to directly from this one (no wall in between). */
export function openNeighbors(maze: Maze, col: number, row: number): Cell[] {
  const cell = maze.cells[row][col];
  const result: Cell[] = [];
  for (const s of SIDES) {
    if (cell[s]) continue;
    const c = col + STEP[s].dx;
    const r = row + STEP[s].dy;
    if (inside(maze, c, r)) result.push({ col: c, row: r });
  }
  return result;
}

/**
 * The fewest cell-to-cell moves from `from` to the nearest of `targets`, and the first step
 * to take. Returns null if there is no target. Used by bots.
 */
export function pathToNearest(maze: Maze, from: Cell, targets: Cell[]): { next: Cell; length: number } | null {
  if (targets.length === 0) return null;
  const goal = new Set(targets.map((t) => t.row * maze.cols + t.col));
  const startKey = from.row * maze.cols + from.col;
  if (goal.has(startKey)) return { next: from, length: 0 };

  const parent = new Map<number, number>([[startKey, -1]]);
  let frontier: Cell[] = [from];
  let length = 0;
  while (frontier.length > 0) {
    length++;
    const following: Cell[] = [];
    for (const cell of frontier) {
      for (const n of openNeighbors(maze, cell.col, cell.row)) {
        const key = n.row * maze.cols + n.col;
        if (parent.has(key)) continue;
        parent.set(key, cell.row * maze.cols + cell.col);
        if (goal.has(key)) {
          // walk back to the cell right after the start
          let step = key;
          while (parent.get(step) !== startKey) step = parent.get(step)!;
          return { next: { col: step % maze.cols, row: Math.floor(step / maze.cols) }, length };
        }
        following.push(n);
      }
    }
    frontier = following;
  }
  return null;
}

/** The wall pieces for a maze, as rectangles. Straight runs are merged into long walls. */
export function mazeToBarriers(maze: Maze, cfg: Config, warningMs: number): Barrier[] {
  const { arena } = cfg;
  const size = cellSize(cfg);
  const t = cfg.maze.thickness;
  const walls: Barrier[] = [];

  const add = (x: number, y: number, width: number, height: number): void => {
    // Keep every wall inside the arena (the ends stick out half a wall thickness).
    const x0 = Math.max(arena.x, x);
    const y0 = Math.max(arena.y, y);
    const x1 = Math.min(arena.x + arena.width, x + width);
    const y1 = Math.min(arena.y + arena.height, y + height);
    walls.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, warningMs });
  };

  // Horizontal walls: between row r and row r + 1.
  for (let r = 0; r < maze.rows - 1; r++) {
    let c = 0;
    while (c < maze.cols) {
      if (!maze.cells[r][c].s) {
        c++;
        continue;
      }
      const startCol = c;
      while (c < maze.cols && maze.cells[r][c].s) c++;
      add(arena.x + startCol * size.width - t / 2, arena.y + (r + 1) * size.height - t / 2, (c - startCol) * size.width + t, t);
    }
  }

  // Vertical walls: between column c and column c + 1.
  for (let c = 0; c < maze.cols - 1; c++) {
    let r = 0;
    while (r < maze.rows) {
      if (!maze.cells[r][c].e) {
        r++;
        continue;
      }
      const startRow = r;
      while (r < maze.rows && maze.cells[r][c].e) r++;
      add(arena.x + (c + 1) * size.width - t / 2, arena.y + startRow * size.height - t / 2, t, (r - startRow) * size.height + t);
    }
  }
  return walls;
}

/**
 * Moves each point to the centre of the nearest cell that nobody else has taken, so every
 * starting spot is in the open and nobody starts on top of anyone.
 */
export function snapToDistinctCells(points: { x: number; y: number }[], cfg: Config): { x: number; y: number }[] {
  const taken = new Set<number>();
  const { cols, rows } = cfg.maze;

  return points.map((p) => {
    const want = cellOf(cfg, p.x, p.y);
    let best: Cell = want;
    let bestDist = Infinity;
    // Search outwards for the closest free cell.
    for (let radius = 0; radius < Math.max(cols, rows); radius++) {
      for (let row = want.row - radius; row <= want.row + radius; row++) {
        for (let col = want.col - radius; col <= want.col + radius; col++) {
          if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
          if (Math.max(Math.abs(col - want.col), Math.abs(row - want.row)) !== radius) continue;
          if (taken.has(row * cols + col)) continue;
          const c = cellCenter(cfg, col, row);
          const d = Math.hypot(c.x - p.x, c.y - p.y);
          if (d < bestDist) {
            best = { col, row };
            bestDist = d;
          }
        }
      }
      if (bestDist < Infinity) break;
    }
    taken.add(best.row * cols + best.col);
    return cellCenter(cfg, best.col, best.row);
  });
}

/** A random cell's centre. */
export function randomCellCenter(rng: Rng, cfg: Config): { x: number; y: number } {
  return cellCenter(cfg, rng.int(0, cfg.maze.cols - 1), rng.int(0, cfg.maze.rows - 1));
}

/** The maze for a given sector: later sectors keep fewer openings, so they are tighter. */
export function mazeForSector(rng: Rng, cfg: Config, sector: number): Maze {
  const chances = cfg.maze.openChanceBySector;
  return generateMaze(rng, cfg, chances[Math.min(sector, chances.length - 1)]);
}
