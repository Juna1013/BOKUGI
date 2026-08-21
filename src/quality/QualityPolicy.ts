export type QualityLevel = 'high' | 'balanced' | 'low';

export interface QualityProfile {
  level: QualityLevel;
  cellSize: number;
  maxRenderDpr: number;
}

export function selectQuality(width: number, height: number, webGpuAvailable: boolean): QualityProfile {
  const requested = new URLSearchParams(location.search).get('quality');
  if (requested === 'high') return { level: 'high', cellSize: 3, maxRenderDpr: 2 };
  if (requested === 'low') return { level: 'low', cellSize: 5, maxRenderDpr: 1 };

  const area = width * height;
  const cores = navigator.hardwareConcurrency || 4;
  if (requested === 'balanced') {
    return { level: 'balanced', cellSize: cellSizeForBudget(area, 180_000), maxRenderDpr: 1.5 };
  }
  if (cores <= 4 || area > 2_800_000) {
    return { level: 'low', cellSize: cellSizeForBudget(area, 120_000), maxRenderDpr: 1 };
  }
  if (webGpuAvailable && cores >= 8 && area < 1_800_000) {
    return { level: 'high', cellSize: 3, maxRenderDpr: 2 };
  }
  return { level: 'balanced', cellSize: cellSizeForBudget(area, 180_000), maxRenderDpr: 1.5 };
}

function cellSizeForBudget(area: number, targetCells: number): number {
  return Math.max(3, Math.min(5, Math.ceil(Math.sqrt(area / targetCells))));
}
