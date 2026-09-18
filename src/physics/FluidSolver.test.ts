import { afterEach, describe, expect, it, vi } from 'vitest';
import { FluidGrid } from './FluidGrid.ts';
import { depositionRate, fiberWeight, FluidSolver, waterGradient } from './FluidSolver.ts';
import { CAP, EDGE_RATE_MAX, DEPOSIT_WET } from '../config.ts';
import type { ColorIndex } from '../types/physics.ts';

function sum(arr: Float32Array): number {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] ?? 0;
  return s;
}

function expectAllFinite(arr: Float32Array, label: string): void {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) throw new Error(`${label}[${i}] is ${arr[i]}`);
  }
}

function totalPigment(grid: FluidGrid): number {
  let s = 0;
  for (let c = 0; c < 3; c++) {
    s += sum(grid.p[c as ColorIndex]) + sum(grid.d[c as ColorIndex]);
  }
  return s;
}

function makeSolver(width = 90, height = 60): FluidSolver {
  return new FluidSolver(new FluidGrid(width, height, 3));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fiberWeight', () => {
  it('sums to 4 over the 8 neighbours regardless of fiber orientation', () => {
    for (const theta of [0, 0.3, Math.PI / 4, Math.PI / 2, 1.9, Math.PI]) {
      const strength = 0.7;
      const cos2 = strength * Math.cos(2 * theta);
      const sin2 = strength * Math.sin(2 * theta);
      let total = 0;
      for (let n = 0; n < 8; n++) total += fiberWeight(n, cos2, sin2);
      expect(total).toBeCloseTo(4, 10);
    }
  });

  it('favours neighbours along the fiber axis', () => {
    // θ = 0: 繊維は水平。左右 (n=0,1) が最大、上下 (n=2,3) が最小。
    const horizontal = fiberWeight(0, 0.7, 0);
    const vertical = fiberWeight(2, 0.7, 0);
    expect(horizontal).toBeGreaterThan(vertical);
    expect(vertical).toBeGreaterThan(0);
  });

  it('is isotropic when the fiber strength is zero', () => {
    const axial = fiberWeight(0, 0, 0);
    const diagonal = fiberWeight(4, 0, 0);
    expect(fiberWeight(2, 0, 0)).toBe(axial);
    expect(fiberWeight(7, 0, 0)).toBe(diagonal);
    expect(axial).toBeCloseTo(diagonal * 2, 10);
  });
});

describe('waterGradient', () => {
  it('is zero on a uniform field', () => {
    const w = new Float32Array(9).fill(0.5);
    expect(waterGradient(w, 4, 3, 3)).toBe(0);
  });

  it('measures the central difference on a horizontal ramp', () => {
    // 3x3、左から右へ 0, 1, 2
    const w = new Float32Array([0, 1, 2, 0, 1, 2, 0, 1, 2]);
    expect(waterGradient(w, 4, 3, 3)).toBeCloseTo(1, 10);
  });

  it('uses one-sided differences at the borders without reading outside', () => {
    const w = new Float32Array([0, 1, 2, 0, 1, 2, 0, 1, 2]);
    // 左端 (x=0): left は自分自身なので (1 - 0) * 0.5
    expect(waterGradient(w, 3, 3, 3)).toBeCloseTo(0.5, 10);
    // 右上の角
    expect(Number.isFinite(waterGradient(w, 2, 3, 3))).toBe(true);
  });
});

describe('depositionRate', () => {
  it('is at least the wet baseline and never exceeds the edge cap', () => {
    for (const water of [0, 0.01, 0.05, 0.2, 1, 2.4]) {
      for (const gradient of [0, 0.01, 0.1, 1, 10]) {
        const rate = depositionRate(water, gradient);
        expect(rate).toBeGreaterThanOrEqual(DEPOSIT_WET);
        expect(rate).toBeLessThanOrEqual(EDGE_RATE_MAX);
      }
    }
  });

  it('increases as the paper dries', () => {
    const wet = depositionRate(0.5, 0);
    const damp = depositionRate(0.1, 0);
    const dry = depositionRate(0, 0);
    expect(dry).toBeGreaterThan(damp);
    expect(damp).toBeGreaterThan(wet);
  });

  it('deposits more at a drying edge than in a flat wet core', () => {
    const core = depositionRate(0.1, 0);
    const edge = depositionRate(0.1, 0.05);
    expect(edge).toBeGreaterThan(core);
  });

  it('does not apply the edge term while the paper is fully wet', () => {
    expect(depositionRate(1, 5)).toBeCloseTo(DEPOSIT_WET, 10);
  });
});

describe('FluidSolver.deposit', () => {
  it('adds water and pigment around the brush centre and marks the cell wet', () => {
    const solver = makeSolver();
    solver.deposit(45, 30, 0.5, 0.3, 4, 0);
    const { grid } = solver;
    const centre = Math.round(30 / 3) * grid.gw + Math.round(45 / 3);
    expect(grid.w[centre]).toBeGreaterThan(CAP);
    expect(grid.p[0][centre]).toBeGreaterThan(0);
    expect(grid.p[1][centre]).toBe(0);
    expect(grid.p[2][centre]).toBe(0);
  });

  it('clamps water and pigment to their ceilings on repeated strokes', () => {
    const solver = makeSolver();
    for (let i = 0; i < 50; i++) solver.deposit(45, 30, 1, 1, 4, 1);
    const { grid } = solver;
    // Float32Array に格納されるので、上限値も float32 に丸めて比べる。
    for (let i = 0; i < grid.N; i++) {
      expect(grid.w[i]).toBeLessThanOrEqual(Math.fround(2.4));
      expect(grid.p[1][i]).toBeLessThanOrEqual(Math.fround(1.5));
    }
  });

  it('grows the content rect to include the stroke', () => {
    const solver = makeSolver();
    solver.grid.restoreContentRect({ x: 40, y: 20, width: 3, height: 3 });
    solver.deposit(10, 10, 0.5, 0.3, 2, 0);
    const rect = solver.grid.getContentRect();
    expect(rect.x).toBeLessThanOrEqual(10 - 2 * 3);
    expect(rect.y).toBeLessThanOrEqual(10 - 2 * 3);
  });
});

describe('FluidSolver.simStep', () => {
  it('never loses water to diffusion and never creates NaN', () => {
    const solver = makeSolver();
    solver.deposit(45, 30, 0.8, 0.5, 5, 0);
    solver.deposit(20, 15, 0.3, 0.9, 3, 2);
    let previous = sum(solver.grid.w);

    for (let step = 0; step < 200; step++) {
      solver.simStep();
      const { grid } = solver;
      expectAllFinite(grid.w, 'w');
      for (let c = 0; c < 3; c++) {
        expectAllFinite(grid.p[c as ColorIndex], `p${c}`);
        expectAllFinite(grid.d[c as ColorIndex], `d${c}`);
      }
      const current = sum(grid.w);
      // 拡散は保存的、蒸発と微小量の切り捨てで減るだけ。
      expect(current).toBeLessThanOrEqual(previous + 1e-4);
      previous = current;
    }
  });

  it('keeps every field non-negative', () => {
    const solver = makeSolver();
    solver.deposit(45, 30, 1, 1, 6, 0);
    for (let step = 0; step < 150; step++) {
      solver.simStep();
      const { grid } = solver;
      for (let i = 0; i < grid.N; i++) {
        expect(grid.w[i]).toBeGreaterThanOrEqual(0);
        for (let c = 0; c < 3; c++) {
          expect(grid.p[c as ColorIndex][i]).toBeGreaterThanOrEqual(0);
          expect(grid.d[c as ColorIndex][i]).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('moves pigment from mobile to fixed without creating mass', () => {
    const solver = makeSolver();
    solver.deposit(45, 30, 0.6, 0.7, 5, 1);
    const before = totalPigment(solver.grid);
    const mobileBefore = sum(solver.grid.p[1]);

    solver.runSteps(300);

    const after = totalPigment(solver.grid);
    // 見えない量 (< 1e-5/セル) を切り捨てる以外に質量は減らない。
    expect(after).toBeLessThanOrEqual(before + 1e-4);
    expect(after).toBeGreaterThan(before - solver.grid.N * 1e-5 - 1e-4);
    expect(sum(solver.grid.p[1])).toBeLessThan(mobileBefore);
    expect(sum(solver.grid.d[1])).toBeGreaterThan(0);
  });

  it('spreads water outwards from the brush', () => {
    const solver = makeSolver();
    solver.deposit(45, 30, 1, 0.5, 2, 0);
    const wetBefore = solver.grid.w.filter((v) => v > CAP).length;
    solver.runSteps(20);
    const wetAfter = solver.grid.w.filter((v) => v > CAP).length;
    expect(wetAfter).toBeGreaterThan(wetBefore);
    // wet はステップ開始時点の濡れセル数。蒸発後の数とは数セル前後しうる。
    expect(solver.wet).toBeGreaterThan(wetBefore);
    expect(Math.abs(solver.wet - wetAfter)).toBeLessThan(wetAfter * 0.1);
  });

  it('eventually dries out completely', () => {
    const solver = makeSolver(30, 30);
    solver.deposit(15, 15, 0.2, 0.2, 2, 0);
    // 蒸発率 0.99972 でも、0.0008 未満の切り捨てがあるので有限ステップで乾く。
    let step = 0;
    while (solver.wet !== 0 || step === 0) {
      solver.simStep();
      if (++step > 30_000) throw new Error('did not stop diffusing');
    }
    // wet === 0 は全セルが CAP 以下という意味。そこから先は蒸発だけで 0 に届く。
    for (let i = 0; i < solver.grid.N; i++) expect(solver.grid.w[i]).toBeLessThanOrEqual(CAP);
    while (sum(solver.grid.w) > 0) {
      solver.simStep();
      if (++step > 60_000) throw new Error('did not dry out');
    }
    expect(sum(solver.grid.w)).toBe(0);
  });

  it('does nothing on a blank sheet', () => {
    const solver = makeSolver();
    solver.simStep();
    expect(solver.wet).toBe(0);
    expect(sum(solver.grid.w)).toBe(0);
    expect(totalPigment(solver.grid)).toBe(0);
  });
});

describe('FluidSolver.advect', () => {
  it('keeps fields finite and non-negative under strong velocities', () => {
    const solver = makeSolver();
    solver.deposit(45, 30, 1, 1, 6, 0);
    solver.addVel(45, 30, 5, -5, 6);
    solver.swirl(45, 30);
    for (let step = 0; step < 50; step++) {
      solver.advect();
      solver.simStep();
    }
    const { grid } = solver;
    expectAllFinite(grid.w, 'w');
    expectAllFinite(grid.u, 'u');
    expectAllFinite(grid.v, 'v');
    for (let i = 0; i < grid.N; i++) {
      expect(grid.w[i]).toBeGreaterThanOrEqual(0);
      expect(grid.p[0][i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('resets non-finite velocities instead of propagating them', () => {
    const solver = makeSolver();
    solver.deposit(45, 30, 1, 1, 4, 0);
    const { grid } = solver;
    const centre = 10 * grid.gw + 15;
    grid.u[centre] = Number.NaN;
    grid.v[centre] = Number.POSITIVE_INFINITY;
    solver.advect();
    expect(solver.grid.u[centre]).toBe(0);
    expect(solver.grid.v[centre]).toBe(0);
    expectAllFinite(solver.grid.w, 'w');
  });

  it('dampens velocity over time', () => {
    const solver = makeSolver();
    solver.deposit(45, 30, 1, 0, 4, 0);
    solver.addVel(45, 30, 2, 0, 4);
    const before = sum(solver.grid.u);
    solver.runSteps(10);
    expect(sum(solver.grid.u)).toBeLessThan(before);
  });
});

describe('FluidSolver.rinseStep', () => {
  it('re-dissolves fixed pigment and washes it down', () => {
    const solver = makeSolver();
    solver.deposit(45, 10, 0.6, 0.8, 5, 0);
    solver.runSteps(400);
    const fixedBefore = sum(solver.grid.d[0]);
    expect(fixedBefore).toBeGreaterThan(0);

    const sweep = 40, total = 200;
    for (let t = 0; t < total; t++) {
      solver.rinseStep(t, sweep, total);
      solver.advect();
      solver.simStep();
    }
    expect(sum(solver.grid.d[0])).toBeLessThan(fixedBefore);
    expect(solver.grid.getContentRect()).toEqual({ x: 0, y: 0, width: 90, height: 60 });
    expectAllFinite(solver.grid.w, 'w');
  });

  it('caps the poured water so it cannot flood the sheet', () => {
    const solver = makeSolver();
    for (let t = 0; t < 100; t++) solver.rinseStep(t, 10, 400);
    for (let i = 0; i < solver.grid.N; i++) {
      expect(solver.grid.w[i]).toBeLessThanOrEqual(2.2 + 0.13);
      expect(solver.grid.v[i]).toBeLessThanOrEqual(1.4 + 0.13);
    }
  });
});

describe('FluidSolver.clearAll', () => {
  it('erases water, pigment, velocity and wet count', () => {
    const solver = makeSolver();
    solver.deposit(45, 30, 1, 1, 5, 2);
    solver.addVel(45, 30, 1, 1, 5);
    solver.runSteps(5);
    solver.clearAll();
    expect(solver.wet).toBe(0);
    expect(sum(solver.grid.w)).toBe(0);
    expect(sum(solver.grid.u)).toBe(0);
    expect(totalPigment(solver.grid)).toBe(0);
  });
});

describe('FluidSolver.resizePreservingState', () => {
  it('returns false and keeps the grid when the size is unchanged', async () => {
    const solver = makeSolver(90, 60);
    solver.deposit(45, 30, 1, 1, 5, 0);
    const before = totalPigment(solver.grid);
    expect(await solver.resizePreservingState(90, 60)).toBe(false);
    expect(totalPigment(solver.grid)).toBe(before);
  });

  it('carries the artwork into a rotated viewport', async () => {
    const solver = makeSolver(90, 60);
    solver.deposit(45, 30, 1, 1, 5, 0);
    solver.runSteps(30);
    const pigmentBefore = totalPigment(solver.grid);

    expect(await solver.resizePreservingState(60, 90)).toBe(true);
    expect(solver.grid.W).toBe(60);
    expect(solver.grid.H).toBe(90);
    const pigmentAfter = totalPigment(solver.grid);
    expect(pigmentAfter).toBeGreaterThan(0);
    // 縮小して収めるので質量は減るが、ゼロにはならず、増えもしない。
    expect(pigmentAfter).toBeLessThanOrEqual(pigmentBefore * 1.05);
    expect(solver.wet).toBe(1);
    expectAllFinite(solver.grid.w, 'w');
  });

  it('honours shouldApply and beforeResize hooks', async () => {
    const solver = makeSolver(90, 60);
    solver.deposit(45, 30, 1, 1, 5, 0);
    const beforeResize = vi.fn();

    expect(
      await solver.resizePreservingState(120, 80, { shouldApply: () => false, beforeResize }),
    ).toBe(false);
    expect(solver.grid.W).toBe(90);
    expect(beforeResize).not.toHaveBeenCalled();

    expect(
      await solver.resizePreservingState(120, 80, { shouldApply: () => true, beforeResize }),
    ).toBe(true);
    expect(beforeResize).toHaveBeenCalledOnce();
    expect(solver.grid.W).toBe(120);
  });
});
