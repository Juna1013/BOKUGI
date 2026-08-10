// 和紙描画
import { ABS } from '../config.js';

export class InkRenderer {
    constructor(canvas) {
        this.inkCv = canvas;
        this.ictx = canvas.getContext('2d');
        this.gridCv = document.createElement('canvas');
        this.gctx = this.gridCv.getContext('2d');
    }

    resize(gw, gh) {
        this.gridCv.width = gw;
        this.gridCv.height = gh;
        this.imgData = this.gctx.createImageData(gw, gh);
        this.imgData.data.fill(255);
        this.initSmoothing();
    }

    initSmoothing() {
        this.ictx.imageSmoothingEnabled = true;
        this.ictx.imageSmoothingQuality = 'medium';
    }

    render(grid, W, H) {
        const { N, d, p, w, grain } = grid;
        const px = this.imgData.data;
        const abs0 = ABS[0], abs1 = ABS[1], abs2 = ABS[2];

        for (let i = 0; i < N; i++) {
            const c0 = d[0][i] * 1.15 + p[0][i] * .55;
            const c1 = d[1][i] * 1.15 + p[1][i] * .55;
            const c2 = d[2][i] * 1.15 + p[2][i] * .55;
            const o = i * 4;

            if (c0 + c1 + c2 < .0004 && w[i] < .01) {
                px[o] = px[o + 1] = px[o + 2] = 255;
                continue;
            }
            const gn = grain[i], sheen = w[i] * .05;
            const absSum0 = c0 * abs0[0] + c1 * abs1[0] + c2 * abs2[0];
            const absSum1 = c0 * abs0[1] + c1 * abs1[1] + c2 * abs2[1];
            const absSum2 = c0 * abs0[2] + c1 * abs1[2] + c2 * abs2[2];
            px[o] = 255 * Math.exp(-(absSum0 + sheen) * gn);
            px[o + 1] = 255 * Math.exp(-(absSum1 + sheen) * gn);
            px[o + 2] = 255 * Math.exp(-(absSum2 + sheen) * gn);
        }
        this.gctx.putImageData(this.imgData, 0, 0);
        this.ictx.clearRect(0, 0, W, H);
        this.ictx.drawImage(this.gridCv, 0, 0, W, H);
    }
}
