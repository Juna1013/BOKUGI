import { isPhoneClassDevice, type GpuProfile } from './DeviceProfile.ts';

export type QualityLevel = 'high' | 'balanced' | 'low';
export type DeviceTier = 'desktop' | 'phone';

export interface QualityProfile {
  level: QualityLevel;
  tier: DeviceTier;
  cellSize: number;
  /** 描画 DPR の上限。FrameBudgetMonitor はここまで上げる。 */
  maxRenderDpr: number;
  /** 描画 DPR の初期値。電話は低めから始め、フレームが速ければ上げる。 */
  initialRenderDpr: number;
}

const HIGH: QualityProfile = {
  level: 'high',
  tier: 'desktop',
  cellSize: 3,
  maxRenderDpr: 2,
  initialRenderDpr: 2,
};

/**
 * @param gpu WebGPU レンダラーと GPU ソルバーが実際に生成できた時のアダプター情報。
 *   `'gpu' in navigator` だけでは adapter 取得失敗時に CPU が高負荷設定を抱えるため、
 *   生成結果を渡すこと。CPU パスなら null。
 */
export function selectQuality(width: number, height: number, gpu: GpuProfile | null): QualityProfile {
  const requested = new URLSearchParams(location.search).get('quality');
  if (requested === 'high') return HIGH;
  if (requested === 'low') {
    return { level: 'low', tier: 'phone', cellSize: 5, maxRenderDpr: 1, initialRenderDpr: 1 };
  }

  const area = width * height;
  if (requested === 'balanced') {
    return {
      level: 'balanced',
      tier: 'desktop',
      cellSize: cellSizeForBudget(area, 180_000),
      maxRenderDpr: 1.5,
      initialRenderDpr: 1.5,
    };
  }

  // GPU では格子の拡大と描画解像度をシェーダーが担うため、画面が大きくても
  // セルを粗くしない。粗いセルは滲みの背景がモザイク状に見える主因になる。
  // 電話サイズの端末は描画 DPR 1.5 から始め、実フレーム間隔が速ければ 2 まで上げる。
  if (gpu) {
    if (isPhoneClassDevice(width, height, gpu)) {
      return { ...HIGH, tier: 'phone', initialRenderDpr: 1.5 };
    }
    return HIGH;
  }

  const cores = navigator.hardwareConcurrency || 4;
  if (cores <= 4 || area > 2_800_000) {
    return {
      level: 'low',
      tier: 'phone',
      cellSize: cellSizeForBudget(area, 120_000),
      maxRenderDpr: 1,
      initialRenderDpr: 1,
    };
  }
  return {
    level: 'balanced',
    tier: 'desktop',
    cellSize: cellSizeForBudget(area, 180_000),
    maxRenderDpr: 1.5,
    initialRenderDpr: 1.5,
  };
}

function cellSizeForBudget(area: number, targetCells: number): number {
  return Math.max(3, Math.min(5, Math.ceil(Math.sqrt(area / targetCells))));
}
