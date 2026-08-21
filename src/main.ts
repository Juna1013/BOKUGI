import { CAP, SUB } from './config.ts';
import { FluidGrid } from './physics/FluidGrid.ts';
import { FluidSolver } from './physics/FluidSolver.ts';
import { PaperRenderer } from './renderer/PaperRenderer.ts';
import { InkRenderer } from './renderer/InkRenderer.ts';
import { WebGpuInkRenderer } from './renderer/WebGpuInkRenderer.ts';
import { InputController } from './interaction/InputController.ts';
import { RinseController } from './interaction/RinseController.ts';
import { CardExporter } from './export/CardExporter.ts';
import { ShareCardController } from './export/ShareCardController.ts';
import { FluidHistory } from './history/FluidHistory.ts';

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
  const history = new FluidHistory(grid);
  const undoButton = document.getElementById('undoButton') as HTMLButtonElement | null;
  const redoButton = document.getElementById('redoButton') as HTMLButtonElement | null;

  const updateHistoryButtons = (): void => {
    if (undoButton) undoButton.disabled = !history.canUndo;
    if (redoButton) redoButton.disabled = !history.canRedo;
  };
  const checkpointHistory = (): void => {
    history.checkpoint();
    updateHistoryButtons();
  };

  const inputController = new InputController(
    inkCv,
    solver,
    renderAll,
    reduceMotion,
    checkpointHistory,
  );
  const rinseController = new RinseController(
    grid,
    reduceMotion,
    renderAll,
    checkpointHistory,
  );

  const restoreHistory = (direction: 'undo' | 'redo'): void => {
    if (inputController.down) return;
    rinseController.rinsing = 0;
    const restored = direction === 'undo' ? history.undo() : history.redo();
    if (!restored) return;
    solver.wet = grid.w.some(value => value > CAP) ? 1 : 0;
    renderAll();
    updateHistoryButtons();
  };

  undoButton?.addEventListener('click', () => restoreHistory('undo'));
  redoButton?.addEventListener('click', () => restoreHistory('redo'));
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      !(event.metaKey || event.ctrlKey) ||
      event.key.toLowerCase() !== 'z'
    ) return;

    event.preventDefault();
    restoreHistory(event.shiftKey ? 'redo' : 'undo');
  });

  function setupCanvas(): void {
    W = window.innerWidth;
    H = window.innerHeight;
    grid.resize(W, H);
    history.clear();
    updateHistoryButtons();
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

  // WebGPU の表示キャンバスは画面提示後に内容が破棄される場合がある。
  // カード生成時だけ現在のグリッドを Canvas 2D へ再描画し、確実に読み出せる画像を渡す。
  let exportInkRenderer: InkRenderer | null = null;
  const getExportInkCanvas = (): HTMLCanvasElement => {
    if (!exportInkRenderer) {
      exportInkRenderer = new InkRenderer(document.createElement('canvas'));
    }

    const exportCanvas = exportInkRenderer.inkCv;
    if (exportCanvas.width !== paper.width || exportCanvas.height !== paper.height) {
      exportCanvas.width = paper.width;
      exportCanvas.height = paper.height;
      exportInkRenderer.ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (exportInkRenderer.gridCv.width !== grid.gw || exportInkRenderer.gridCv.height !== grid.gh) {
      exportInkRenderer.resize(grid.gw, grid.gh);
    }
    exportInkRenderer.render(grid, W, H);
    return exportCanvas;
  };

  const cardExporter = new CardExporter(paper, getExportInkCanvas);
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
