// 水洗い機能
export class RinseController {
    constructor(grid, reduceMotion, renderFn) {
        this.grid = grid;
        this.reduceMotion = reduceMotion;
        this.renderFn = renderFn;
        this.rinsing = 0;
        this.R_SWEEP = 70;
        this.R_TOTAL = 290;

        document.getElementById('rinse')?.addEventListener('click', () => {
            if (this.reduceMotion) {
                this.grid.clearAll();
                this.renderFn();
            } else if (!this.rinsing) {
                this.rinsing = 1;
            }
        });
    }

    step() {
        if (!this.rinsing) return;
        const { gh, gw, w, v, u, ambU, d, p, N } = this.grid;
        const t = this.rinsing;
        const frontRow = Math.min(gh, ((gh * t / this.R_SWEEP) | 0) + 2);
        const pouring = t < this.R_TOTAL - 100;

        for (let y = 0; y < frontRow; y++) {
            const row = y * gw;
            for (let x = 0; x < gw; x++) {
                const i = row + x;
                if (pouring && w[i] < 2.2) w[i] += .13;
                if (v[i] < 1.4) v[i] += .13;
                u[i] += (Math.random() - .5) * .07 + ambU[i] * .5;
                const dis = Math.min(w[i], 1.2) * .05;
                if (dis > 0) {
                    for (let c = 0; c < 3; c++) {
                        const m = d[c][i] * dis;
                        d[c][i] -= m; p[c][i] += m;
                    }
                }
            }
        }
        for (let y = gh - 3; y < gh; y++) {
            const row = y * gw;
            for (let x = 0; x < gw; x++) {
                const i = row + x;
                w[i] *= .55;
                for (let c = 0; c < 3; c++) { p[c][i] *= .5; d[c][i] *= .9; }
            }
        }
        if (!pouring) {
            for (let i = 0; i < N; i++) {
                w[i] *= .95;
                for (let c = 0; c < 3; c++) { d[c][i] *= .94; p[c][i] *= .94; }
            }
        }
        if (++this.rinsing > this.R_TOTAL) {
            this.grid.clearAll();
            this.rinsing = 0;
        }
    }
}
