// エントリポインタ・メインループ
import { SUB } from './config.js';
import { FluidGrid } from './physics/FluidGrid.js';
import { FluidSolver } from './physics/FluidSolver.js';
import { PaperRenderer } from './renderer/PaperRenderer.js';
import { InkRenderer } from './renderer/InkRenderer.js';
import { InputController } from './interaction/InputController.js';
import { RinseController } from './interaction/RinseController.js';

(() => {
    'use strict';

    const paper = document.getElementById('paper');
    const inkCv = document.getElementById('inkLayer');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    let W = innerWidth, H = innerHeight;

    const grid = new FluidGrid(W, H);
    const solver = new FluidSolver(grid);
    const paperRenderer = new PaperRenderer(paper);
    const inkRenderer = new InkRenderer(inkCv);

    const renderAll = () => inkRenderer.render(grid, W, H);

    const inputController = new InputController(inkCv, solver, renderAll, reduceMotion);
    const rinseController = new RinseController(grid, reduceMotion, renderAll);

    function setupCanvas() {
        W = innerWidth; H = innerHeight;
        grid.resize(W, H);
        inkRenderer.resize(grid.gw, grid.gh);

        for (const c of [paper, inkCv]) {
            c.width = W * dpr; c.height = H * dpr;
            c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        inkRenderer.initSmoothing();
        paperRenderer.render(W, H);
        renderAll();
    }

    setupCanvas();

    let resizeT;
    window.addEventListener('resize', () => {
        clearTimeout(resizeT);
        resizeT = setTimeout(setupCanvas, 200);
    });

    function loop() {
        if (!reduceMotion) {
            inputController.updateHold();
            for (let s = 0; s < SUB; s++) solver.simStep();
            solver.advect();
            rinseController.step();

            if (solver.wet > 0 || rinseController.rinsing || inputController.down) {
                renderAll();
            }
        }
        requestAnimationFrame(loop);
    }

    loop();
})();
