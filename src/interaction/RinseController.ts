import type { FluidGrid } from '../physics/FluidGrid.ts';
import type { ColorIndex } from '../types/physics.ts';

export class RinseController {
  public grid: FluidGrid;
  public reduceMotion: boolean;
  public renderFn: () => void;
  public rinsing: number = 0;
  public R_SWEEP: number = 70;
  public R_TOTAL: number = 290;

  constructor(grid: FluidGrid, reduceMotion: boolean, renderFn: () => void) {
    this.grid = grid;
    this.reduceMotion = reduceMotion;
    this.renderFn = renderFn;

    document.getElementById('rinse')?.addEventListener('click', () => {
      if (this.reduceMotion) {
        this.grid.clearAll();
        this.renderFn();
      } else if (!this.rinsing) {
        this.rinsing = 1;
      }
    });
  }

  public step(): void {
    if (!this.rinsing) return;
    const { gh, gw, w, v, u, ambU, d, p, N } = this.grid;
    const t = this.rinsing;
    const frontRow = Math.min(gh, ((gh * t / this.R_SWEEP) | 0) + 2);
    const pouring = t < this.R_TOTAL - 100;

    for (let y = 0; y < frontRow; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        const wi = w[i] ?? 0;
        const vi = v[i] ?? 0;
        const ambUi = ambU[i] ?? 0;

        if (pouring && wi < 2.2) w[i] = wi + 0.13;
        if (vi < 1.4) v[i] = vi + 0.13;
        if (u[i] !== undefined) u[i] += (Math.random() - 0.5) * 0.07 + ambUi * 0.5;

        const dis = Math.min(w[i] ?? 0, 1.2) * 0.05;
        if (dis > 0) {
          for (let c = 0; c < 3; c++) {
            const dc = d[c as ColorIndex];
            const pc = p[c as ColorIndex];

            const dci = dc[i] ?? 0;
            const pci = pc[i] ?? 0;
            const m = dci * dis;
            dc[i] = dci - m;
            pc[i] = pci + m;
          }
        }
      }
    }

    for (let y = gh - 3; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        w[i]! *= 0.55;
        for (let c = 0; c < 3; c++) {
          p[c as ColorIndex][i]! *= 0.5;
          d[c as ColorIndex][i]! *= 0.9;
        }
      }
    }

    if (!pouring) {
      for (let i = 0; i < N; i++) {
        w[i]! *= 0.95;
        for (let c = 0; c < 3; c++) {
          d[c as ColorIndex][i]! *= 0.94;
          p[c as ColorIndex][i]! *= 0.94;
        }
      }
    }

    if (++this.rinsing > this.R_TOTAL) {
      this.grid.clearAll();
      this.rinsing = 0;
    }
  }
}
