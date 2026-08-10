// 格子データ・配列管理
import { CS, AMB } from '../config.js';
import { makeNoise } from './Noise.js';

export class FluidGrid {
    constructor(W, H) {
        this.CS = CS;
        this.resize(W, H);
    }

    resize(W, H) {
        this.W = W;
        this.H = H;
        this.gw = Math.ceil(W / CS);
        this.gh = Math.ceil(H / CS);
        this.N = this.gw * this.gh;

        this.w = new Float32Array(this.N);
        this.w2 = new Float32Array(this.N);
        this.u = new Float32Array(this.N);
        this.v = new Float32Array(this.N);
        this.ambU = new Float32Array(this.N);
        this.ambV = new Float32Array(this.N);
        this.perm = new Float32Array(this.N);
        this.grain = new Float32Array(this.N);

        this.p = [new Float32Array(this.N), new Float32Array(this.N), new Float32Array(this.N)]; // 浮遊顔料
        this.p2 = [new Float32Array(this.N), new Float32Array(this.N), new Float32Array(this.N)];
        this.d = [new Float32Array(this.N), new Float32Array(this.N), new Float32Array(this.N)]; // 定着顔料

        this.buildFields();
    }

    buildFields() {
        const { gw, gh, perm, grain, ambU, ambV } = this;
        const n1 = makeNoise(24, 60), s1x = 24 / gw, s1y = 60 / gh;
        const n2 = makeNoise(70, 160), s2x = 70 / gw, s2y = 160 / gh;
        const n3 = makeNoise(200, 400), s3x = 200 / gw, s3y = 400 / gh;
        for (let y = 0; y < gh; y++) {
            for (let x = 0; x < gw; x++) {
                const i = y * gw + x;
                let val = n1(x * s1x, y * s1y) * .45 + n2(x * s2x, y * s2y) * .35 + n3(x * s3x, y * s3y) * .20;
                perm[i] = Math.min(1.4, Math.pow(val, 1.6) * 1.9 + 0.12);
                grain[i] = .82 + Math.random() * .36;
            }
        }
        const nf = makeNoise(14, 14), sx = 14 / gw, sy = 14 / gh, eps = 1.5;
        for (let y = 0; y < gh; y++) {
            for (let x = 0; x < gw; x++) {
                const i = y * gw + x;
                const dndy = nf(x * sx, (y + eps) * sy) - nf(x * sx, Math.max(0, y - eps) * sy);
                const dndx = nf((x + eps) * sx, y * sy) - nf(Math.max(0, x - eps) * sx, y * sy);
                ambU[i] = dndy * AMB / eps;
                ambV[i] = -dndx * AMB / eps;
            }
        }
    }

    gridArea(cx, cy, R, fn) {
        const { CS, gw, gh } = this;
        const gx = cx / CS, gy = cy / CS, r2 = R * R;
        const x0 = Math.max(0, (gx - R) | 0), x1 = Math.min(gw - 1, Math.ceil(gx + R));
        const y0 = Math.max(0, (gy - R) | 0), y1 = Math.min(gh - 1, Math.ceil(gy + R));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const dx = x - gx, dy = y - gy, q2 = dx * dx + dy * dy;
                if (q2 <= r2) fn(y * gw + x, dx, dy, q2);
            }
        }
    }
    clearAll() {
        this.w.fill(0); this.u.fill(0); this.v.fill(0);
        for (let c = 0; c < 3; c++) {
            this.p[c].fill(0);
            this.d[c].fill(0);
        }
    }
}
