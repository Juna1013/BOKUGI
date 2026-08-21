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
  public lastPressure: number = 0.5;
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
      this.lastT = e.timeStamp;
      this.lastPressure = this.pointerPressure(e);

      hint?.classList.add('gone');
      this.solver.drop(
        e.clientX,
        e.clientY,
        1.1 + this.lastPressure,
        2.5 + this.lastPressure * 4,
        this.curColor,
      );
      this.solver.swirl(e.clientX, e.clientY);

      if (this.reduceMotion) {
        for (let k = 0; k < 260; k++) this.solver.simStep();
        this.renderFn();
      }
    });

    this.inkCv.addEventListener('pointermove', (e: PointerEvent) => {
      if (!this.down || e.pointerId !== this.activePointerId) return;
      const coalesced = e.getCoalescedEvents();
      const samples = coalesced.length > 0 ? coalesced : [e];
      for (const sample of samples) this.processPointerSample(sample);
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
      this.solver.drop(
        this.lastX,
        this.lastY,
        0.3 + this.lastPressure * 0.4,
        2.5 + this.lastPressure * 3,
        this.curColor,
      );
    }
  }

  private processPointerSample(e: PointerEvent): void {
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    const dist = Math.hypot(dx, dy);
    if (dist <= CS) return;

    const pressure = this.pointerPressure(e);
    const dt = Math.max(e.timeStamp - this.lastT, 1);
    const gain = Math.min((dist / dt) * 10, 3.5);
    const velocityRadius = 4.5 + pressure * 3;
    this.solver.addVel(
      e.clientX,
      e.clientY,
      (dx / dist) * gain,
      (dy / dist) * gain,
      velocityRadius,
    );

    const count = Math.ceil(dist / CS);
    const speedAmount = Math.max(0.25, 1.1 - (dist / dt) * 0.12);
    for (let k = 1; k <= count; k++) {
      const progress = k / count;
      const stampPressure = this.lastPressure + (pressure - this.lastPressure) * progress;
      this.solver.drop(
        this.lastX + dx * progress,
        this.lastY + dy * progress,
        speedAmount * 0.45 * (0.35 + stampPressure * 1.3),
        2 + stampPressure * 2.4,
        this.curColor,
      );
    }

    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastT = e.timeStamp;
    this.lastPressure = pressure;
  }

  private pointerPressure(e: PointerEvent): number {
    if (e.pointerType !== 'pen') return 0.5;
    return Math.max(0.05, Math.min(e.pressure, 1));
  }
}
