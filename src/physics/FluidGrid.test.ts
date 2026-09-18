import { describe, expect, it } from 'vitest';
import { FluidGrid } from './FluidGrid.ts';
import type { ColorIndex } from '../types/physics.ts';

function fillDisc(grid: FluidGrid, cx: number, cy: number, r: number, value: number): void {
  grid.gridArea(cx, cy, r, (i) => {
    grid.w[i] = value;
    grid.p[0][i] = value;
    grid.d[0][i] = value;
  });
  grid.includeArea(cx, cy, r * grid.CS);
}

function centroid(grid: FluidGrid, arr: Float32Array): { x: number; y: number; mass: number } {
  let mx = 0, my = 0, mass = 0;
  for (let y = 0; y < grid.gh; y++) {
    for (let x = 0; x < grid.gw; x++) {
      const v = arr[y * grid.gw + x] ?? 0;
      mx += x * v;
      my += y * v;
      mass += v;
    }
  }
  // セル中心の座標 (CSS px) で返す
  return { x: (mx / mass + 0.5) * grid.CS, y: (my / mass + 0.5) * grid.CS, mass };
}

describe('FluidGrid construction', () => {
  it('rounds the grid up so it always covers the viewport', () => {
    const grid = new FluidGrid(100, 50, 3);
    expect(grid.gw).toBe(34);
    expect(grid.gh).toBe(17);
    expect(grid.N).toBe(34 * 17);
    expect(grid.w.length).toBe(grid.N);
    expect(grid.p[2].length).toBe(grid.N);
    expect(grid.getContentRect()).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it('builds paper fields within their expected ranges', () => {
    const grid = new FluidGrid(300, 200, 3);
    for (let i = 0; i < grid.N; i++) {
      const perm = grid.perm[i] ?? 0;
      expect(perm).toBeGreaterThan(0);
      expect(perm).toBeLessThanOrEqual(1.4);
      const grain = grid.grain[i] ?? 0;
      expect(grain).toBeGreaterThanOrEqual(0.88);
      expect(grain).toBeLessThanOrEqual(0.88 + 0.24);
      // 繊維の強さ |(cos2, sin2)| は FIBER_ANISO 以下
      const c = grid.fiberCos2[i] ?? 0, s = grid.fiberSin2[i] ?? 0;
      expect(Math.hypot(c, s)).toBeLessThanOrEqual(0.7 + 1e-6);
      expect(Number.isFinite(grid.ambU[i])).toBe(true);
      expect(Number.isFinite(grid.ambV[i])).toBe(true);
    }
  });
});

describe('FluidGrid.gridArea', () => {
  it('visits exactly the cells inside the circle', () => {
    const grid = new FluidGrid(90, 90, 3);
    const visited = new Set<number>();
    grid.gridArea(45, 45, 4, (i, dx, dy, q2) => {
      expect(q2).toBeCloseTo(dx * dx + dy * dy, 10);
      expect(q2).toBeLessThanOrEqual(16);
      visited.add(i);
    });
    // 半径 4 セルの円: おおよそ π·16 ≈ 50 セル
    expect(visited.size).toBeGreaterThan(40);
    expect(visited.size).toBeLessThan(60);
  });

  it('clips the scan to the grid at the corners', () => {
    const grid = new FluidGrid(30, 30, 3);
    let count = 0;
    grid.gridArea(0, 0, 3, (i) => {
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(grid.N);
      count++;
    });
    expect(count).toBeGreaterThan(0);
    // 右下の角も範囲内だけ
    grid.gridArea(30, 30, 3, (i) => {
      expect(i).toBeLessThan(grid.N);
    });
  });
});

describe('content rect bookkeeping', () => {
  it('includeArea grows the rect and clamps to the viewport', () => {
    const grid = new FluidGrid(100, 100, 5);
    grid.restoreContentRect({ x: 40, y: 40, width: 10, height: 10 });
    grid.includeArea(5, 5, 20);
    expect(grid.getContentRect()).toEqual({ x: 0, y: 0, width: 50, height: 50 });
    grid.includeArea(95, 95, 20);
    expect(grid.getContentRect()).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it('restoreContentRect never yields a rect smaller than one cell or outside the sheet', () => {
    const grid = new FluidGrid(100, 100, 5);
    grid.restoreContentRect({ x: -50, y: 200, width: 1, height: 1 });
    const rect = grid.getContentRect();
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(100);
    expect(rect.width).toBe(5);
    expect(rect.height).toBe(5);
  });

  it('clearAll and includeViewport reset the rect to the full sheet', () => {
    const grid = new FluidGrid(100, 80, 5);
    grid.restoreContentRect({ x: 10, y: 10, width: 10, height: 10 });
    grid.includeViewport();
    expect(grid.getContentRect()).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    grid.restoreContentRect({ x: 10, y: 10, width: 10, height: 10 });
    grid.w.fill(1);
    grid.clearAll();
    expect(grid.getContentRect()).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(grid.w.every((v) => v === 0)).toBe(true);
  });
});

describe('captureState / restoreFittedState', () => {
  it('round-trips losslessly at the same size', () => {
    const grid = new FluidGrid(90, 60, 3);
    fillDisc(grid, 45, 30, 4, 0.8);
    const state = grid.captureState();
    const fresh = new FluidGrid(90, 60, 3);
    fresh.restoreFittedState(state);
    expect(Array.from(fresh.w)).toEqual(Array.from(grid.w));
    expect(Array.from(fresh.d[0])).toEqual(Array.from(grid.d[0]));
    expect(fresh.getContentRect()).toEqual(grid.getContentRect());
  });

  it('captures independent copies rather than aliases', () => {
    const grid = new FluidGrid(30, 30, 3);
    grid.w[0] = 1;
    const state = grid.captureState();
    grid.w[0] = 0;
    expect(state.water[0]).toBe(1);
  });

  it('keeps the whole artwork visible and centred after a rotation', () => {
    const grid = new FluidGrid(120, 60, 3);
    fillDisc(grid, 60, 30, 5, 1);
    // 作品は横長シート全体とみなす
    grid.includeViewport();
    const state = grid.captureState();

    const rotated = new FluidGrid(60, 120, 3);
    rotated.restoreFittedState(state);

    const rect = rotated.getContentRect();
    // 幅 120→60 に収まるよう 0.5 倍、高さは 30 になり縦中央へ
    expect(rect.width).toBeCloseTo(60, 5);
    expect(rect.height).toBeCloseTo(30, 5);
    expect(rect.x).toBeCloseTo(0, 5);
    expect(rect.y).toBeCloseTo(45, 5);

    const c = centroid(rotated, rotated.d[0]);
    expect(c.mass).toBeGreaterThan(0);
    // 最近傍サンプリングなので 1 セル (3px) の誤差は許容する
    expect(Math.abs(c.x - 30)).toBeLessThan(3);
    expect(Math.abs(c.y - 60)).toBeLessThan(3);

    // 余白は白紙のまま
    for (let y = 0; y < rotated.gh; y++) {
      const targetY = (y + 0.5) * 3;
      if (targetY < 45 || targetY > 75) {
        for (let x = 0; x < rotated.gw; x++) {
          expect(rotated.w[y * rotated.gw + x]).toBe(0);
        }
      }
    }
  });

  it('copies the restored fields into the double buffers', () => {
    const grid = new FluidGrid(60, 60, 3);
    fillDisc(grid, 30, 30, 4, 0.5);
    const target = new FluidGrid(60, 60, 3);
    target.restoreFittedState(grid.captureState());
    expect(Array.from(target.w2)).toEqual(Array.from(target.w));
    for (let c = 0; c < 3; c++) {
      const idx = c as ColorIndex;
      expect(Array.from(target.p2[idx])).toEqual(Array.from(target.p[idx]));
    }
  });

  it('ignores degenerate states instead of corrupting the grid', () => {
    const grid = new FluidGrid(60, 60, 3);
    const state = grid.captureState();
    state.contentRect = { x: 0, y: 0, width: 0, height: 0 };
    const target = new FluidGrid(60, 60, 3);
    target.w[0] = 0.3;
    target.restoreFittedState(state);
    expect(target.w[0]).toBe(Math.fround(0.3));

    const empty = grid.captureState();
    empty.columns = 0;
    target.restoreFittedState(empty);
    expect(target.w[0]).toBe(Math.fround(0.3));
  });
});
