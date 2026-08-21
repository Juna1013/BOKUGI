import { BRUSH_PRESETS, CS } from '../config.ts';
import type { FluidSolver } from '../physics/FluidSolver.ts';
import type { BrushKind } from '../types/brush.ts';
import type { ColorIndex } from '../types/physics.ts';

export class InputController {
  public inkCv: HTMLCanvasElement;
  public solver: FluidSolver;
  public renderFn: () => void;
  public reduceMotion: boolean;
  public onStrokeStart: () => void;
  public curColor: ColorIndex = 0;
  public curBrush: BrushKind = 'dark';
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
    reduceMotion: boolean,
    onStrokeStart: () => void,
  ) {
    this.inkCv = inkCanvas;
    this.solver = solver;
    this.renderFn = renderFn;
    this.reduceMotion = reduceMotion;
    this.onStrokeStart = onStrokeStart;

    this.initPalette();
    this.initBrushes();
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
        swatches.forEach(s => {
          const selected = s === b;
          s.classList.toggle('on', selected);
          s.setAttribute('aria-checked', String(selected));
        });
      });
    });
  }

  private initBrushes(): void {
    const brushes = document.querySelectorAll<HTMLButtonElement>('.brushes button');
    brushes.forEach(button => {
      button.addEventListener('click', () => {
        const brush = button.dataset['brush'];
        if (brush === 'water' || brush === 'light' || brush === 'dark') {
          this.curBrush = brush;
        }
        brushes.forEach(item => {
          const selected = item === button;
          item.classList.toggle('on', selected);
          item.setAttribute('aria-checked', String(selected));
        });
      });
    });
  }

  private initEvents(): void {
    const hint = document.getElementById('hint');

    this.inkCv.addEventListener('pointerdown', (e: PointerEvent) => {
      if (this.activePointerId !== null) return;
      this.onStrokeStart();
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
      this.depositStamp(
        e.clientX,
        e.clientY,
        1.1 + this.lastPressure,
        2.5 + this.lastPressure * 4,
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
      this.depositStamp(
        this.lastX,
        this.lastY,
        0.3 + this.lastPressure * 0.4,
        2.5 + this.lastPressure * 3,
      );
    }
  }

  private processPointerSample(e: PointerEvent): void {
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    const dist = Math.hypot(dx, dy);
    if (dist <= this.solver.grid.CS) return;

    const pressure = this.pointerPressure(e);
    const dt = Math.max(e.timeStamp - this.lastT, 1);
    const gain = Math.min((dist / dt) * 10, 3.5);
    const preset = BRUSH_PRESETS[this.curBrush];
    const radiusScale = CS / this.solver.grid.CS;
    const velocityRadius = 4.5 + pressure * 3;
    this.solver.addVel(
      e.clientX,
      e.clientY,
      (dx / dist) * gain * preset.momentum,
      (dy / dist) * gain * preset.momentum,
      velocityRadius * preset.radius * radiusScale,
    );

    const count = Math.ceil(dist / this.solver.grid.CS);
    const speedAmount = Math.max(0.25, 1.1 - (dist / dt) * 0.12);
    for (let k = 1; k <= count; k++) {
      const progress = k / count;
      const stampPressure = this.lastPressure + (pressure - this.lastPressure) * progress;
      this.depositStamp(
        this.lastX + dx * progress,
        this.lastY + dy * progress,
        speedAmount * 0.45 * (0.35 + stampPressure * 1.3),
        2 + stampPressure * 2.4,
      );
    }

    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastT = e.timeStamp;
    this.lastPressure = pressure;
  }

  private depositStamp(x: number, y: number, amount: number, radius: number): void {
    const preset = BRUSH_PRESETS[this.curBrush];
    this.solver.deposit(
      x,
      y,
      amount * preset.water,
      amount * 0.55 * preset.pigment,
      radius * preset.radius * (CS / this.solver.grid.CS),
      this.curColor,
    );
  }

  private pointerPressure(e: PointerEvent): number {
    if (e.pointerType !== 'pen') return 0.5;
    return Math.max(0.05, Math.min(e.pressure, 1));
  }
}
