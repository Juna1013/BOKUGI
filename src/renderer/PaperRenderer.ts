import { FIBER_ANISO } from '../config.ts';
import type { FluidGrid } from '../physics/FluidGrid.ts';

export class PaperRenderer {
  public canvas: HTMLCanvasElement;
  public ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D rendering context for Paper Canvas');
    }
    this.ctx = ctx;
  }

  /**
   * 和紙を描く。grid を渡すと繊維を物理場の繊維方向（fiberCos2 / fiberSin2）に揃えるので、
   * 目に見える繊維と、墨が滲み足を伸ばす向きが一致する。
   */
  public render(W: number, H: number, grid?: FluidGrid): void {
    const { ctx } = this;
    ctx.fillStyle = '#f2ede1';
    ctx.fillRect(0, 0, W, H);

    const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(255,252,244,.55)');
    g.addColorStop(1, 'rgba(214,206,188,.5)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const fiberAngle = this.fiberAngleSampler(grid);

    // 長い繊維（楮）。薄く長く、繊維の向きに沿って走る。
    this.strokeFibers(W, H, Math.floor((W * H) / 9000), 14, 30, 0.7, 'rgba(120,110,90,.03)', fiberAngle);
    // 短い繊維。従来どおりの密度で、向きだけ場に合わせる。
    this.strokeFibers(W, H, Math.floor((W * H) / 2600), 4, 14, 0.6, 'rgba(120,110,90,.05)', fiberAngle);

    const grainCount = Math.floor((W * H) / 1400);
    for (let i = 0; i < grainCount; i++) {
      ctx.fillStyle = `rgba(110,100,80,${0.02 + Math.random() * 0.04})`;
      ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
    }
  }

  private strokeFibers(
    W: number,
    H: number,
    count: number,
    minLength: number,
    lengthRange: number,
    lineWidth: number,
    style: string,
    fiberAngle: (x: number, y: number) => number,
  ): void {
    const { ctx } = this;
    ctx.strokeStyle = style;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const a = fiberAngle(x, y);
      const l = minLength + Math.random() * lengthRange;
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
    }
    ctx.stroke();
  }

  /**
   * 位置から繊維の角度を返す。場が強く揃った所ほど場の向きに忠実で、
   * ほぐれた所ほど乱れる。grid が無ければ従来どおり一様乱数。
   */
  private fiberAngleSampler(grid?: FluidGrid): (x: number, y: number) => number {
    if (!grid) return () => Math.random() * Math.PI;
    const { CS, gw, gh, fiberCos2, fiberSin2 } = grid;
    return (x, y) => {
      const gx = Math.min(gw - 1, Math.max(0, Math.floor(x / CS)));
      const gy = Math.min(gh - 1, Math.max(0, Math.floor(y / CS)));
      const i = gy * gw + gx;
      const c = fiberCos2[i] ?? 0;
      const s = fiberSin2[i] ?? 0;
      const alignment = Math.min(1, Math.hypot(c, s) / FIBER_ANISO);
      const theta = 0.5 * Math.atan2(s, c);
      return theta + (Math.random() - 0.5) * Math.PI * (1 - alignment) * 0.9;
    };
  }
}
