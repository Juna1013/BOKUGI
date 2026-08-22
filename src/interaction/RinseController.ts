import type { FluidSolver } from '../physics/FluidSolver.ts';

export class RinseController {
  public solver: FluidSolver;
  public reduceMotion: boolean;
  public renderFn: () => void;
  public rinsing: number = 0;
  public R_SWEEP: number = 70;
  public R_TOTAL: number = 290;
  private enabled = true;

  constructor(
    solver: FluidSolver,
    reduceMotion: boolean,
    renderFn: () => void,
    onRinseStart: () => void,
  ) {
    this.solver = solver;
    this.reduceMotion = reduceMotion;
    this.renderFn = renderFn;

    document.getElementById('rinse')?.addEventListener('click', () => {
      if (!this.enabled || this.rinsing) return;
      onRinseStart();
      if (this.reduceMotion) {
        this.solver.clearAll();
        this.renderFn();
      } else {
        this.rinsing = 1;
      }
    });
  }

  public step(): void {
    if (!this.rinsing) return;
    this.solver.rinseStep(this.rinsing, this.R_SWEEP, this.R_TOTAL);
    if (++this.rinsing > this.R_TOTAL) {
      this.solver.clearAll();
      this.rinsing = 0;
    }
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}
