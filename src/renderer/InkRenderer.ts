import { ABS, PIGMENT_DENSITY } from '../config.ts';
import type { FluidGrid } from '../physics/FluidGrid.ts';

export class InkRenderer {
  public inkCv: HTMLCanvasElement;
  public ictx: CanvasRenderingContext2D;
  public gridCv: HTMLCanvasElement;
  public gctx: CanvasRenderingContext2D;
  public imgData!: ImageData;

  constructor(canvas: HTMLCanvasElement) {
    this.inkCv = canvas;
    const ictx = canvas.getContext('2d');
    if (!ictx) {
      throw new Error('Failed to get 2D rendering context for Ink Canvas');
    }
    this.ictx = ictx;

    this.gridCv = document.createElement('canvas');
    const gctx = this.gridCv.getContext('2d');
    if (!gctx) {
      throw new Error('Failed to get 2D rendering context for Grid Canvas');
    }
    this.gctx = gctx;
  }

  public resize(gw: number, gh: number): void {
    this.gridCv.width = gw;
    this.gridCv.height = gh;
    this.imgData = this.gctx.createImageData(gw, gh);
    this.imgData.data.fill(255);
    this.initSmoothing();
  }

  public initSmoothing(): void {
    this.ictx.imageSmoothingEnabled = true;
    this.ictx.imageSmoothingQuality = 'medium';
  }

  public render(grid: FluidGrid, W: number, H: number): void {
    const { N, d, p, w, grain } = grid;
    const px = this.imgData.data;
    const abs0 = ABS[0], abs1 = ABS[1], abs2 = ABS[2];

    const d0 = d[0], d1 = d[1], d2 = d[2];
    const p0 = p[0], p1 = p[1], p2 = p[2];

    for (let i = 0; i < N; i++) {
      const d0i = d0[i] ?? 0, d1i = d1[i] ?? 0, d2i = d2[i] ?? 0;
      const p0i = p0[i] ?? 0, p1i = p1[i] ?? 0, p2i = p2[i] ?? 0;
      const wi = w[i] ?? 0;

      const c0 = d0i * 1.15 + p0i * 0.55;
      const c1 = d1i * 1.15 + p1i * 0.55;
      const c2 = d2i * 1.15 + p2i * 0.55;
      const o = i * 4;

      if (c0 + c1 + c2 < 0.0004 && wi < 0.01) {
        px[o] = 255;
        px[o + 1] = 255;
        px[o + 2] = 255;
        px[o + 3] = 255;
        continue;
      }

      const gn = grain[i] ?? 1.0;
      const sheen = wi * 0.05;

      const absSum0 = c0 * abs0[0] + c1 * abs1[0] + c2 * abs2[0];
      const absSum1 = c0 * abs0[1] + c1 * abs1[1] + c2 * abs2[1];
      const absSum2 = c0 * abs0[2] + c1 * abs1[2] + c2 * abs2[2];

      px[o] = 255 * Math.exp(-(absSum0 * PIGMENT_DENSITY + sheen) * gn);
      px[o + 1] = 255 * Math.exp(-(absSum1 * PIGMENT_DENSITY + sheen) * gn);
      px[o + 2] = 255 * Math.exp(-(absSum2 * PIGMENT_DENSITY + sheen) * gn);
      px[o + 3] = 255;
    }

    this.gctx.putImageData(this.imgData, 0, 0);
    this.ictx.clearRect(0, 0, W, H);
    this.ictx.drawImage(this.gridCv, 0, 0, W, H);
  }
}
