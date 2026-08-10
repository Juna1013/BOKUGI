import { CS } from '../config.ts';
import type { FluidSolver } from '../physics/FluidSolver.ts';
import type { ColorIndex } from '../types/physics.ts';

export class InputController {
  public inkCv: HTMLCanvasElement;
  public solver: FluidSolver;
  public renderFn: () => void;
  public reduceMotion: boolean;
  public curColor: ColorIndex = 0;
  public down: boolean = false;
  public activePointerId: number | null = null;
  public lastX: number = 0;
  public lastY: number = 0;
  public lastT: number = 0;
  public holdT: number = 0;

  constructor(
    inkCanvas: HTMLCanvasElement,
    solver: FluidSolver,
    renderFn: () => void,
    reduceMotion: boolean
  ) {
    this.inkCv = inkCanvas;
    this.solver = solver;
    this.renderFn = renderFn;
    this.reduceMotion = reduceMotion;

    this.initPalette();
    this.initEvents();
  }

  private initPalette(): void {
    const swatches = document.querySelectorAll<HTMLButtonElement>('.palette button');
    swatches.forEach(b => {
      b.addEventListener('click', () => {
        const c = Number(b.dataset['c']);
        if (c === 0 || c === 1 || c === 2) {
          this.curColor = c;
        }
        swatches.forEach(s => s.classList.toggle('on', s === b));
      });
    });
  }

  private initEvents(): void {
    const hint = document.getElementById('hint');

    this.inkCv.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.activePointerId !== null) return;
      this.activePointerId = e.pointerId;
      this.down = true;
      this.holdT = 0;
      try {
        this.inkCv.setPointerCapture(e.pointerId);
      } catch (_) {}

      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.lastT = performance.now();

      hint?.classList.add('gone');
      this.solver.drop(e.clientX, e.clientY, 1.6, 4.5, this.curColor);
      this.solver.swirl(e.clientX, e.clientY);

      if (this.reduceMotion) {
        for (let k = 0; k < 260; k++) this.solver.simStep();
        this.renderFn();
      }
    });

    this.inkCv.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.down || e.pointerId !== this.activePointerId) return;
      const now = performance.now();
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
      const dist = Math.hypot(dx, dy);

      if (dist > CS) {
        const dt = Math.max(now - this.lastT, 8);
        const gain = Math.min((dist / dt) * 10, 3.5);
        this.solver.addVel(e.clientX, e.clientY, (dx / dist) * gain, (dy / dist) * gain, 6);

        const n = Math.ceil(dist / CS);
        const a = Math.max(0.25, 1.1 - dist * 0.02);
        for (let k = 1; k <= n; k++) {
          this.solver.drop(
            this.lastX + (dx * k) / n,
            this.lastY + (dy * k) / n,
            a * 0.45,
            3.2,
            this.curColor
          );
        }
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.lastT = now;
      }
    });

    const up = (e: PointerEvent) => {
      if (e.pointerId === this.activePointerId) {
        this.down = false;
        this.activePointerId = null;
        try {
          this.inkCv.releasePointerCapture(e.pointerId);
        } catch (_) {}
      }
    };

    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  public updateHold(): void {
    if (this.down && ++this.holdT > 20 && this.holdT % 6 === 0) {
      this.solver.drop(this.lastX, this.lastY, 0.5, 4, this.curColor);
    }
  }
}
