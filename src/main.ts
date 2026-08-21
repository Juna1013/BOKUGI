import { SUB } from './config.ts';
import { FluidGrid } from './physics/FluidGrid.ts';
import { FluidSolver } from './physics/FluidSolver.ts';
import { PaperRenderer } from './renderer/PaperRenderer.ts';
import { InkRenderer } from './renderer/InkRenderer.ts';
import { WebGpuInkRenderer } from './renderer/WebGpuInkRenderer.ts';
import { InputController } from './interaction/InputController.ts';
import { RinseController } from './interaction/RinseController.ts';
import { CardExporter } from './export/CardExporter.ts';
import { ShareCardController } from './export/ShareCardController.ts';

void (async () => {
  'use strict';

  const paper = document.getElementById('paper') as HTMLCanvasElement | null;
  const inkCv = document.getElementById('inkLayer') as HTMLCanvasElement | null;

  if (!paper || !inkCv) {
    throw new Error('Canvas elements (#paper, #inkLayer) not found in DOM.');
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = window.innerWidth;
  let H = window.innerHeight;

  const grid = new FluidGrid(W, H);
  const solver = new FluidSolver(grid);
  const paperRenderer = new PaperRenderer(paper);
  // WebGPU は色計算と格子補間を GPU に委譲する。利用できない環境では 2D 描画を継続する。
  const inkRenderer = (await WebGpuInkRenderer.create(inkCv)) ?? new InkRenderer(inkCv);

  const renderAll = (): void => inkRenderer.render(grid, W, H);

  const inputController = new InputController(inkCv, solver, renderAll, reduceMotion);
  const rinseController = new RinseController(grid, reduceMotion, renderAll);

  function setupCanvas(): void {
    W = window.innerWidth;
    H = window.innerHeight;
    grid.resize(W, H);
    inkRenderer.resize(grid.gw, grid.gh);

    if (paper && inkCv) {
      for (const c of [paper, inkCv]) {
        c.width = W * dpr;
        c.height = H * dpr;
        c.getContext('2d')?.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
    inkRenderer.initSmoothing();
    paperRenderer.render(W, H);
    renderAll();
  }

  setupCanvas();

  const cardExporter = new CardExporter(paper, inkCv);
  new ShareCardController(cardExporter);

  let resizeT: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    if (resizeT !== undefined) clearTimeout(resizeT);
    resizeT = setTimeout(setupCanvas, 200);
  });

  function loop(): void {
    if (!reduceMotion) {
      inputController.updateHold();
      for (let s = 0; s < SUB; s++) solver.simStep();
      solver.advect();
      rinseController.step();

      if (solver.wet > 0 || rinseController.rinsing > 0 || inputController.down) {
        renderAll();
      }
    }
    requestAnimationFrame(loop);
  }

  loop();
})();
