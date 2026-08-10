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

  public render(W: number, H: number): void {
    const { ctx } = this;
    ctx.fillStyle = '#f2ede1';
    ctx.fillRect(0, 0, W, H);

    const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 0, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    g.addColorStop(0, 'rgba(255,252,244,.55)');
    g.addColorStop(1, 'rgba(214,206,188,.5)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = 'rgba(120,110,90,.05)';
    ctx.lineWidth = 0.6;

    const fiberCount = Math.floor((W * H) / 2600);
    for (let i = 0; i < fiberCount; i++) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const a = Math.random() * Math.PI;
      const l = 4 + Math.random() * 14;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      ctx.stroke();
    }

    const grainCount = Math.floor((W * H) / 1400);
    for (let i = 0; i < grainCount; i++) {
      ctx.fillStyle = `rgba(110,100,80,${0.02 + Math.random() * 0.04})`;
      ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1);
    }
  }
}
