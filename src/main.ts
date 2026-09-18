import { SUB } from './config.ts';
import { FluidGrid } from './physics/FluidGrid.ts';
import { FluidSolver } from './physics/FluidSolver.ts';
import { PaperRenderer } from './renderer/PaperRenderer.ts';
import { InkRenderer } from './renderer/InkRenderer.ts';
import { WebGpuInkRenderer } from './renderer/WebGpuInkRenderer.ts';
import { InputController } from './interaction/InputController.ts';
import { RinseController } from './interaction/RinseController.ts';
import { FlowController } from './interaction/FlowController.ts';
import { CardExporter } from './export/CardExporter.ts';
import { ShareCardController } from './export/ShareCardController.ts';
import {
  CreatorProfileStore,
  SessionCreatorProfileStore,
} from './export/CreatorProfile.ts';
import { FrameBudgetMonitor } from './quality/FrameBudgetMonitor.ts';
import { selectQuality } from './quality/QualityPolicy.ts';
import { SimulationCoordinator } from './session/SimulationCoordinator.ts';
import { AttractController } from './session/AttractController.ts';

void (async () => {
  'use strict';

  const paper = document.getElementById('paper') as HTMLCanvasElement | null;
  const inkCv = document.getElementById('inkLayer') as HTMLCanvasElement | null;

  if (!paper || !inkCv) {
    throw new Error('Canvas elements (#paper, #inkLayer) not found in DOM.');
  }

  const exhibitionMode = new URLSearchParams(window.location.search).get('mode') === 'exhibition';
  document.documentElement.dataset['mode'] = exhibitionMode ? 'exhibition' : 'standard';

  const creatorName = document.getElementById('creatorName') as HTMLInputElement | null;
  const shareDialog = document.getElementById('shareDialog') as HTMLDialogElement | null;
  if (exhibitionMode) {
    const creatorProfileNote = document.getElementById('creatorProfileNote');
    creatorName?.setAttribute('autocomplete', 'off');
    if (creatorProfileNote) {
      creatorProfileNote.textContent =
        '作者名はこの展示セッション中だけ保持され、次の作品を始めると消去されます。';
    }
  }

  const deviceDpr = Math.min(window.devicePixelRatio || 1, 2);
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const touchViewport =
    navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;

  let W = window.innerWidth;
  let H = window.innerHeight;
  const paperRenderer = new PaperRenderer(paper);
  // 品質判定は GPU レンダラーが実際に作れたかで行う。navigator.gpu があっても
  // adapter が取れず CPU に落ちる環境で、高負荷設定を抱えないため。
  const gpuInkRenderer = await WebGpuInkRenderer.create(inkCv);
  const quality = selectQuality(W, H, gpuInkRenderer?.profile ?? null);
  let renderDpr = Math.min(deviceDpr, quality.initialRenderDpr);

  // 端末でどの経路と品質が選ばれたかを、リモートインスペクタから確認できるようにする。
  console.info(
    gpuInkRenderer
      ? `BOKUGI: WebGPU (${gpuInkRenderer.profile.vendor || 'unknown'} / ${gpuInkRenderer.profile.architecture || 'unknown'})`
      : 'BOKUGI: Canvas 2D fallback',
    `tier=${quality.tier} cell=${quality.cellSize}px dpr=${renderDpr}`,
  );

  const grid = new FluidGrid(W, H, quality.cellSize);
  const gpuSolver = gpuInkRenderer?.createSolver(grid) ?? null;
  const solver: FluidSolver = gpuSolver ?? new FluidSolver(grid);
  const cpuInkRenderer = gpuInkRenderer ? null : new InkRenderer(inkCv);

  // GPU時は流体storage bufferを直接描画し、フレームごとのCPU readbackを避ける。
  const renderAll = (): void => {
    if (gpuInkRenderer && gpuSolver) gpuInkRenderer.render(gpuSolver, W, H);
    else cpuInkRenderer?.render(grid, W, H);
  };
  let simulationBusy = false;

  const inputController = new InputController(
    inkCv,
    solver,
    renderAll,
    reduceMotion,
  );
  const rinseController = new RinseController(
    solver,
    reduceMotion,
    renderAll,
  );
  const flowController = new FlowController(solver, reduceMotion);
  let attractController: AttractController | null = null;
  const simulationCoordinator = new SimulationCoordinator((busy) => {
    simulationBusy = busy;
    inputController.setEnabled(!busy);
    rinseController.setEnabled(!busy);
    attractController?.setEnabled(!busy);
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

  function resizeRendererGrid(): void {
    if (gpuInkRenderer) gpuInkRenderer.resize(grid);
    else cpuInkRenderer?.resize(grid.gw, grid.gh);
  }

  function resizePresentationSurfaces(): void {
    if (!paper) return;
    paper.width = W * deviceDpr;
    paper.height = H * deviceDpr;
    paper.getContext('2d')?.setTransform(deviceDpr, 0, 0, deviceDpr, 0, 0);
    resizeInkSurface();
    // 和紙の繊維は物理場の繊維方向に揃える。墨の滲み足が伸びる向きと一致する。
    paperRenderer.render(W, H, grid);
    renderAll();
  }

  resizeRendererGrid();
  resizePresentationSurfaces();

  // WebGPU の表示キャンバスは画面提示後に内容が破棄される場合がある。
  // カード生成時は GPU でオフスクリーンに描いて読み戻し、画面と同じ見た目の画像を渡す。
  // GPU の読み戻しに失敗した時と CPU パスでは、グリッドを Canvas 2D へ再描画する。
  let exportInkRenderer: InkRenderer | null = null;
  const getExportInkCanvas = (): Promise<HTMLCanvasElement> =>
    simulationCoordinator.runExclusive(async () => {
      if (!exportInkRenderer) {
        exportInkRenderer = new InkRenderer(document.createElement('canvas'));
      }

      const exportCanvas = exportInkRenderer.inkCv;
      if (exportCanvas.width !== paper.width || exportCanvas.height !== paper.height) {
        exportCanvas.width = paper.width;
        exportCanvas.height = paper.height;
        exportInkRenderer.ictx.setTransform(deviceDpr, 0, 0, deviceDpr, 0, 0);
      }

      if (gpuInkRenderer && gpuSolver) {
        try {
          await gpuInkRenderer.renderToCanvas(gpuSolver, exportCanvas);
          return exportCanvas;
        } catch (error: unknown) {
          console.warn('GPU からの書き出しに失敗したため、CPU 描画で書き出します。', error);
        }
      }

      const readback = solver.readback();
      if (readback) await readback;
      if (
        exportInkRenderer.gridCv.width !== grid.gw ||
        exportInkRenderer.gridCv.height !== grid.gh
      ) {
        exportInkRenderer.resize(grid.gw, grid.gh);
      }
      exportInkRenderer.render(grid, W, H);
      return exportCanvas;
    });

  const cardExporter = new CardExporter(paper, getExportInkCanvas);
  const profileStore = exhibitionMode
    ? new SessionCreatorProfileStore()
    : new CreatorProfileStore();
  const shareCardController = new ShareCardController(cardExporter, profileStore);

  // 展示端末では、無人になったら前の来場者の作品と作者名を片付け、
  // 墨の所作を自動再生して次の来場者を待つ。
  if (exhibitionMode && !reduceMotion) {
    attractController = new AttractController(solver, rinseController, inkCv, renderAll, {
      onEnter: () => {
        shareCardController.resetSession();
        flowController.set(false);
      },
    });
  }

  // ?detail=basic で画素シェーディングを簡略化した見た目を確かめられる（比較・検証用）。
  const requestedDetail = new URLSearchParams(window.location.search).get('detail');
  const initialDetail = requestedDetail === 'basic' ? 'basic' : 'full';
  gpuInkRenderer?.setDetail(initialDetail);
  const frameBudget = new FrameBudgetMonitor(
    { dpr: renderDpr, detail: initialDetail },
    Math.min(deviceDpr, quality.maxRenderDpr),
    (next) => {
      console.info(`BOKUGI: 描画品質を変更 dpr=${next.dpr} detail=${next.detail}`);
      gpuInkRenderer?.setDetail(next.detail);
      if (next.dpr !== renderDpr) {
        renderDpr = next.dpr;
        resizeInkSurface();
      }
      renderAll();
    },
  );

  let resizeT: ReturnType<typeof setTimeout> | undefined;
  let resizeRevision = 0;
  window.addEventListener('resize', () => {
    const nextWidth = Math.max(1, Math.round(window.innerWidth));
    const nextHeight = Math.max(1, Math.round(window.innerHeight));
    const widthChanged = nextWidth !== W;
    const heightChanged = nextHeight !== H;
    const revision = ++resizeRevision;
    if (resizeT !== undefined) clearTimeout(resizeT);
    resizeT = undefined;

    // タッチ端末の高さだけの変化は、キーボードやブラウザUIによるvisual viewport変更。
    // ダイアログ中も同じ扱いにし、blur/closeとのイベント順に依存させない。
    const transientHeightResize =
      !widthChanged &&
      heightChanged &&
      (touchViewport || shareDialog?.open === true);
    if (transientHeightResize || (!widthChanged && !heightChanged)) return;

    resizeT = setTimeout(() => {
      resizeT = undefined;
      void simulationCoordinator.runExclusive(async () => {
        if (revision !== resizeRevision) return;
        rinseController.rinsing = 0;
        const resized = await solver.resizePreservingState(nextWidth, nextHeight, {
          shouldApply: () => revision === resizeRevision,
        });
        if (!resized) return;

        W = nextWidth;
        H = nextHeight;
        resizeRendererGrid();
        resizePresentationSurfaces();
        frameBudget.reset();
      }).catch((error: unknown) => {
        console.error('作品を保持したまま表示領域を変更できませんでした。', error);
        // 格子とGPU資源の更新途中で失敗した可能性があるため、不整合状態を継続しない。
        window.location.reload();
      });
    }, 200);
  });

  function loop(frameTime: number): void {
    if (!reduceMotion && !simulationBusy) {
      const active = solver.wet > 0 || rinseController.rinsing > 0 || inputController.down;
      attractController?.update();
      inputController.updateHold();
      solver.runSteps(SUB);
      solver.advect();
      rinseController.step();
      flowController.step(rinseController.rinsing > 0);

      if (solver.wet > 0 || rinseController.rinsing > 0 || inputController.down) {
        renderAll();
      }
      // GPU が飽和した時は CPU 側の処理時間には出ず、フレーム間隔が伸びる。
      // そのため rAF のタイムスタンプで実フレーム間隔を測る。
      if (active && !document.hidden) frameBudget.sample(frameTime);
    }
    requestAnimationFrame(loop);
  }

  loop(performance.now());
})();
