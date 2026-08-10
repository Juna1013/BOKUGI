// ポインター操作
import { CS } from '../config.js';

export class InputController {
    constructor(inkCanvas, solver, renderFn, reduceMotion) {
        this.inkCv = inkCanvas;
        this.solver = solver;
        this.renderFn = renderFn;
        this.reduceMotion = reduceMotion;
        this.curColor = 0;
        this.down = false;
        this.activePointerId = null;
        this.lastX = 0; this.lastY = 0; this.lastT = 0; this.holdT = 0;

        this.initPalette();
        this.initEvents();
    }

    initPalette() {
        const swatches = document.querySelectorAll('.palette button');
        swatches.forEach(b => b.addEventListener('click', () => {
            this.curColor = +b.dataset.c;
            swatches.forEach(s => s.classList.toggle('on', s === b));
        }));
    }

    initEvents() {
        const hint = document.getElementById('hint');

        this.inkCv.addEventListener('pointerdown', e => {
            if (this.activePointerId !== null) return;
            this.activePointerId = e.pointerId;
            this.down = true; this.holdT = 0;
            try { this.inkCv.setPointerCapture(e.pointerId); } catch (_) { }
            this.lastX = e.clientX; this.lastY = e.clientY; this.lastT = performance.now();

            hint?.classList.add('gone');
            this.solver.drop(e.clientX, e.clientY, 1.6, 4.5, this.curColor);
            this.solver.swirl(e.clientX, e.clientY);

            if (this.reduceMotion) {
                for (let k = 0; k < 260; k++) this.solver.simStep();
                this.renderFn();
            }
        });

        this.inkCv.addEventListener('pointermove', e => {
            if (!this.down || e.pointerId !== this.activePointerId) return;
            const now = performance.now();
            const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY;
            const dist = Math.hypot(dx, dy);
            if (dist > CS) {
                const dt = Math.max(now - this.lastT, 8);
                const gain = Math.min(dist / dt * 10, 3.5);
                this.solver.addVel(e.clientX, e.clientY, dx / dist * gain, dy / dist * gain, 6);

                const n = Math.ceil(dist / CS);
                const a = Math.max(.25, 1.1 - dist * .02);
                for (let k = 1; k <= n; k++)
                    this.solver.drop(this.lastX + dx * k / n, this.lastY + dy * k / n, a * .45, 3.2, this.curColor);
                this.lastX = e.clientX; this.lastY = e.clientY; this.lastT = now;
            }
        });

        const up = e => {
            if (e.pointerId === this.activePointerId) {
                this.down = false;
                this.activePointerId = null;
                try { this.inkCv.releasePointerCapture(e.pointerId); } catch (_) { }
            }
        };
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    }

    updateHold() {
        if (this.down && ++this.holdT > 20 && this.holdT % 6 === 0) {
            this.solver.drop(this.lastX, this.lastY, .5, 4, this.curColor);
        }
    }
}
