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
import {
  CreatorProfileStore,
  SessionCreatorProfileStore,
} from './export/CreatorProfile.ts';
import { FluidHistory } from './history/FluidHistory.ts';
import { FrameBudgetMonitor } from './quality/FrameBudgetMonitor.ts';
import { selectQuality } from './quality/QualityPolicy.ts';

void (async () => {
  'use strict';

  const paper = document.getElementById('paper') as HTMLCanvasElement | null;
  const inkCv = document.getElementById('inkLayer') as HTMLCanvasElement | null;

  if (!paper || !inkCv) {
    throw new Error('Canvas elements (#paper, #inkLayer) not found in DOM.');
  }

  const exhibitionMode = new URLSearchParams(window.location.search).get('mode') === 'exhibition';
  document.documentElement.dataset['mode'] = exhibitionMode ? 'exhibition' : 'standard';

  if (exhibitionMode) {
    const creatorName = document.getElementById('creatorName') as HTMLInputElement | null;
    const creatorProfileNote = document.getElementById('creatorProfileNote');
    creatorName?.setAttribute('autocomplete', 'off');
    if (creatorProfileNote) {
      creatorProfileNote.textContent =
        '作者名はこの展示セッション中だけ保持され、次の作品を始めると消去されます。';
    }
  }

  const deviceDpr = Math.min(window.devicePixelRatio || 1, 2);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = window.innerWidth;
  let H = window.innerHeight;
  const webGpuAvailable = 'gpu' in navigator;
  const quality = selectQuality(W, H, webGpuAvailable);
  let renderDpr = Math.min(deviceDpr, quality.maxRenderDpr);

  const grid = new FluidGrid(W, H, quality.cellSize);
  const paperRenderer = new PaperRenderer(paper);
  const gpuInkRenderer = await WebGpuInkRenderer.create(inkCv);
  const gpuSolver = gpuInkRenderer?.createSolver(grid) ?? null;
  const solver: FluidSolver = gpuSolver ?? new FluidSolver(grid);
  const cpuInkRenderer = gpuInkRenderer ? null : new InkRenderer(inkCv);

  // GPU時は流体storage bufferを直接描画し、フレームごとのCPU readbackを避ける。
  const renderAll = (): void => {
    if (gpuInkRenderer && gpuSolver) gpuInkRenderer.render(gpuSolver, W, H);
    else cpuInkRenderer?.render(grid, W, H);
  };
  const history = new FluidHistory(solver);
  const undoButton = document.getElementById('undoButton') as HTMLButtonElement | null;
  const redoButton = document.getElementById('redoButton') as HTMLButtonElement | null;

  const updateHistoryButtons = (): void => {
    if (undoButton) undoButton.disabled = !history.canUndo;
    if (redoButton) redoButton.disabled = !history.canRedo;
  };
  const checkpointHistory = (): void => {
    const checkpoint = history.checkpoint();
    updateHistoryButtons();
    void checkpoint.then(updateHistoryButtons);
  };

  const inputController = new InputController(
    inkCv,
    solver,
    renderAll,
    reduceMotion,
    checkpointHistory,
  );
  const rinseController = new RinseController(
    solver,
    reduceMotion,
    renderAll,
    checkpointHistory,
  );

  const restoreHistory = async (direction: 'undo' | 'redo'): Promise<void> => {
    if (inputController.down) return;
    rinseController.rinsing = 0;
    const restored = direction === 'undo' ? await history.undo() : await history.redo();
    if (!restored) return;
    solver.wet = grid.w.some(value => value > CAP) ? 1 : 0;
    renderAll();
    updateHistoryButtons();
  };

  undoButton?.addEventListener('click', () => void restoreHistory('undo'));
  redoButton?.addEventListener('click', () => void restoreHistory('redo'));
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
    void restoreHistory(event.shiftKey ? 'redo' : 'undo');
  });

  function resizeInkSurface(): void {
    if (!inkCv) return;
    inkCv.width = W * renderDpr;
    inkCv.height = H * renderDpr;
    if (cpuInkRenderer) {
      inkCv.getContext('2d')?.setTransform(renderDpr, 0, 0, renderDpr, 0, 0);
      cpuInkRenderer.initSmoothing();
    } else {
      gpuInkRenderer?.initSmoothing();
    }
  }

  function setupCanvas(): void {
    if (!paper) return;
    W = window.innerWidth;
    H = window.innerHeight;
    solver.resize(W, H);
    history.clear();
    updateHistoryButtons();
    if (gpuInkRenderer) gpuInkRenderer.resize(grid.gw, grid.gh);
    else cpuInkRenderer?.resize(grid.gw, grid.gh);

    paper.width = W * deviceDpr;
    paper.height = H * deviceDpr;
    paper.getContext('2d')?.setTransform(deviceDpr, 0, 0, deviceDpr, 0, 0);
    resizeInkSurface();
    paperRenderer.render(W, H);
    renderAll();
  }

  setupCanvas();

  // WebGPU の表示キャンバスは画面提示後に内容が破棄される場合がある。
  // カード生成時だけ現在のグリッドを Canvas 2D へ再描画し、確実に読み出せる画像を渡す。
  let exportInkRenderer: InkRenderer | null = null;
  const getExportInkCanvas = async (): Promise<HTMLCanvasElement> => {
    const readback = solver.readback();
    if (readback) await readback;
    if (!exportInkRenderer) {
      exportInkRenderer = new InkRenderer(document.createElement('canvas'));
    }

    const exportCanvas = exportInkRenderer.inkCv;
    if (exportCanvas.width !== paper.width || exportCanvas.height !== paper.height) {
      exportCanvas.width = paper.width;
      exportCanvas.height = paper.height;
      exportInkRenderer.ictx.setTransform(deviceDpr, 0, 0, deviceDpr, 0, 0);
    }
    if (exportInkRenderer.gridCv.width !== grid.gw || exportInkRenderer.gridCv.height !== grid.gh) {
      exportInkRenderer.resize(grid.gw, grid.gh);
    }
    exportInkRenderer.render(grid, W, H);
    return exportCanvas;
  };

  const cardExporter = new CardExporter(paper, getExportInkCanvas);
  const profileStore = exhibitionMode
    ? new SessionCreatorProfileStore()
    : new CreatorProfileStore();
  new ShareCardController(cardExporter, profileStore);

  const frameBudget = new FrameBudgetMonitor(
    renderDpr,
    Math.min(deviceDpr, quality.maxRenderDpr),
    (nextDpr) => {
      renderDpr = nextDpr;
      resizeInkSurface();
      renderAll();
    },
  );

  let resizeT: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    if (resizeT !== undefined) clearTimeout(resizeT);
    resizeT = setTimeout(setupCanvas, 200);
  });

  function loop(): void {
    if (!reduceMotion) {
      const active = solver.wet > 0 || rinseController.rinsing > 0 || inputController.down;
      const startedAt = performance.now();
      inputController.updateHold();
      solver.runSteps(SUB);
      solver.advect();
      rinseController.step();

      if (solver.wet > 0 || rinseController.rinsing > 0 || inputController.down) {
        renderAll();
      }
      if (active && !document.hidden) frameBudget.sample(performance.now() - startedAt);
    }
    requestAnimationFrame(loop);
  }

  loop();
})();
