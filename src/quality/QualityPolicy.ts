export type QualityLevel = 'high' | 'balanced' | 'low';

export interface QualityProfile {
  level: QualityLevel;
  cellSize: number;
  maxRenderDpr: number;
}

const HIGH: QualityProfile = { level: 'high', cellSize: 3, maxRenderDpr: 2 };

/**
 * @param webGpuAvailable WebGPU レンダラーと GPU ソルバーが実際に生成できたか。
 *   `'gpu' in navigator` だけでは adapter 取得失敗時に CPU が高負荷設定を抱えるため、
 *   生成結果を渡すこと。
 */
export function selectQuality(width: number, height: number, webGpuAvailable: boolean): QualityProfile {
  const requested = new URLSearchParams(location.search).get('quality');
  if (requested === 'high') return HIGH;
  if (requested === 'low') return { level: 'low', cellSize: 5, maxRenderDpr: 1 };

  const area = width * height;
  if (requested === 'balanced') {
    return { level: 'balanced', cellSize: cellSizeForBudget(area, 180_000), maxRenderDpr: 1.5 };
  }

  // GPU では格子の拡大と描画解像度をシェーダーが担うため、画面が大きくても
  // セルを粗くしない。粗いセルは滲みの背景がモザイク状に見える主因になる。
  if (webGpuAvailable) return HIGH;

  const cores = navigator.hardwareConcurrency || 4;
  if (cores <= 4 || area > 2_800_000) {
    return { level: 'low', cellSize: cellSizeForBudget(area, 120_000), maxRenderDpr: 1 };
  }
  return { level: 'balanced', cellSize: cellSizeForBudget(area, 180_000), maxRenderDpr: 1.5 };
}

function cellSizeForBudget(area: number, targetCells: number): number {
  return Math.max(3, Math.min(5, Math.ceil(Math.sqrt(area / targetCells))));
}
