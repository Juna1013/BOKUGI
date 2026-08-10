// 物理アルゴリズム
import { DIFF, CAP, EVAP, VDAMP } from '../config.js';

export class FluidSolver {
    constructor(grid) {
        this.grid = grid;
        this.wet = 0;
    }

    // 1. 毛細管拡散・蒸発・顔料定着
    simStep() {
        const { gw, gh, N, w, w2, u, v, perm, p, p2, d } = this.grid;
        w2.set(w);
        p2[0].set(p[0]); p2[1].set(p[1]); p2[2].set(p[2]);
        this.wet = 0;

        for (let y = 0; y < gh; y++) {
            const row = y * gw;
            for (let x = 0; x < gw; x++) {
                const i = row + x;
                const wi = w[i];
                if (wi <= CAP) continue;
                this.wet++;
                const inv = 1 / wi;

                // Left
                if (x > 0) {
                    const j = i - 1, dw = wi - w[j];
                    if (dw > 0) {
                        const f = Math.min(DIFF * perm[j] * dw * (.6 + Math.random() * .8), wi * .18);
                        w2[j] += f; w2[i] -= f;
                        const fr = f * inv;
                        const p0i = p[0][i], p1i = p[1][i], p2i = p[2][i];
                        if (p0i > 0) { p2[0][j] += fr * p0i; p2[0][i] -= fr * p0i; }
                        if (p1i > 0) { p2[1][j] += fr * p1i; p2[1][i] -= fr * p1i; }
                        if (p2i > 0) { p2[2][j] += fr * p2i; p2[2][i] -= fr * p2i; }
                    }
                }
                // Right
                if (x < gw - 1) {
                    const j = i + 1, dw = wi - w[j];
                    if (dw > 0) {
                        const f = Math.min(DIFF * perm[j] * dw * (.6 + Math.random() * .8), wi * .18);
                        w2[j] += f; w2[i] -= f;
                        const fr = f * inv;
                        const p0i = p[0][i], p1i = p[1][i], p2i = p[2][i];
                        if (p0i > 0) { p2[0][j] += fr * p0i; p2[0][i] -= fr * p0i; }
                        if (p1i > 0) { p2[1][j] += fr * p1i; p2[1][i] -= fr * p2i; }
                        if (p2i > 0) { p2[2][j] += fr * p2i; p2[2][i] -= fr * p2i; }
                    }
                }
                // Top
                if (y > 0) {
                    const j = i - gw, dw = wi - w[j];
                    if (dw > 0) {
                        const f = Math.min(DIFF * perm[j] * dw * (.6 + Math.random() * .8), wi * .18);
                        w2[j] += f; w2[i] -= f;
                        const fr = f * inv;
                        const p0i = p[0][i], p1i = p[1][i], p2i = p[2][i];
                        if (p0i > 0) { p2[0][j] += fr * p0i; p2[0][i] -= fr * p0i; }
                        if (p1i > 0) { p2[1][j] += fr * p1i; p2[1][i] -= fr * p1i; }
                        if (p2i > 0) { p2[2][j] += fr * p2i; p2[2][i] -= fr * p2i; }
                    }
                }
                // Bottom
                if (y < gh - 1) {
                    const j = i + gw, dw = wi - w[j];
                    if (dw > 0) {
                        const f = Math.min(DIFF * perm[j] * dw * (.6 + Math.random() * .8), wi * .18);
                        w2[j] += f; w2[i] -= f;
                        const fr = f * inv;
                        const p0i = p[0][i], p1i = p[1][i], p2i = p[2][i];
                        if (p0i > 0) { p2[0][j] += fr * p0i; p2[0][i] -= fr * p0i; }
                        if (p1i > 0) { p2[1][j] += fr * p1i; p2[1][i] -= fr * p1i; }
                        if (p2i > 0) { p2[2][j] += fr * p2i; p2[2][i] -= fr * p2i; }
                    }
                }
            }
        }

        for (let i = 0; i < N; i++) {
            let wi = w2[i] * EVAP;
            if (wi < 0.0008) wi = 0;
            const dry = 1 - Math.min(wi * 6, 1);
            const rate = 0.003 + 0.05 * dry * dry;
            for (let c = 0; c < 3; c++) {
                const pv = p2[c][i];
                if (pv > 0) {
                    const dep = pv * rate;
                    d[c][i] += dep;
                    p[c][i] = pv - dep;
                } else {
                    p[c][i] = pv;
                }
            }
            w[i] = wi;
            u[i] *= VDAMP; v[i] *= VDAMP;
        }
    }

    // 2. セミ・ラグランジュ移流
    advect() {
        const { gw, gh, w, w2, u, v, ambU, ambV, p, p2 } = this.grid;
        w2.set(w);
        p2[0].set(p[0]); p2[1].set(p[1]); p2[2].set(p[2]);

        for (let y = 0; y < gh; y++) {
            const row = y * gw;
            for (let x = 0; x < gw; x++) {
                const i = row + x;
                const wi = w[i];
                const g = Math.min(wi * 3.5, 1);
                if (g < .02) continue;
                const vx = (u[i] + ambU[i]) * g, vy = (v[i] + ambV[i]) * g;
                if (!Number.isFinite(vx) || !Number.isFinite(vy)) { u[i] = 0; v[i] = 0; continue; }
                if (vx * vx + vy * vy < 1e-6) continue;

                const sx = Math.max(0, Math.min(gw - 1.001, x - vx));
                const sy2 = Math.max(0, Math.min(gh - 1.001, y - vy));
                const x0 = sx | 0, y0 = sy2 | 0;
                const fx = sx - x0, fy = sy2 - y0;
                const j00 = y0 * gw + x0, j10 = j00 + 1, j01 = j00 + gw, j11 = j01 + 1;
                const a00 = (1 - fx) * (1 - fy), a10 = fx * (1 - fy), a01 = (1 - fx) * fy, a11 = fx * fy;

                const bl_w = w[j00] * a00 + w[j10] * a10 + w[j01] * a01 + w[j11] * a11;
                w2[i] = wi + (bl_w - wi) * g;
                for (let c = 0; c < 3; c++) {
                    const pc = p[c];
                    const bl_p = pc[j00] * a00 + pc[j10] * a10 + pc[j01] * a01 + pc[j11] * a11;
                    p2[c][i] = pc[i] + (bl_p - pc[i]) * g;
                }
            }
        }
        [this.grid.w, this.grid.w2] = [this.grid.w2, this.grid.w];
        for (let c = 0; c < 3; c++) {
            [this.grid.p[c], this.grid.p2[c]] = [this.grid.p2[c], this.grid.p[c]];
        }
    }

    // 3. インク落墨
    drop(cx, cy, amount, radius, curColor) {
        const r2 = radius * radius, pc = this.grid.p[curColor];
        this.grid.gridArea(cx, cy, radius, (i, dx, dy, q2) => {
            const fall = Math.exp(-q2 / (r2 * .35));
            this.grid.w[i] = Math.min(this.grid.w[i] + amount * fall, 2.4);
            pc[i] = Math.min(pc[i] + amount * fall * .55, 1.5);
        });
    }

    // 4. 運動量・速度の付与
    addVel(cx, cy, vx, vy, radius) {
        const r2 = radius * radius;
        this.grid.gridArea(cx, cy, radius, (i, dx, dy, q2) => {
            const fall = Math.exp(-q2 / (r2 * .4));
            this.grid.u[i] += vx * fall;
            this.grid.v[i] += vy * fall;
        });
    }

    // 5. 渦運動の付与
    swirl(cx, cy) {
        const R = 9, dir = Math.random() < .5 ? 1 : -1;
        this.grid.gridArea(cx, cy, R, (i, dx, dy, q2) => {
            const q = Math.sqrt(q2);
            if (q < .5) return;
            const s = dir * .9 * Math.exp(-q2 / (R * R * .3)) / q;
            this.grid.u[i] += -dy * s;
            this.grid.v[i] += dx * s;
        });
    }
}
