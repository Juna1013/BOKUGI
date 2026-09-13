import type { GpuAdapter } from '../renderer/WebGpuTypes.ts';

/** WebGPU アダプターから読める範囲の端末情報。品質の初期値と書き出し上限に使う。 */
export interface GpuProfile {
  vendor: string;
  architecture: string;
  description: string;
  /** SwiftShader などのソフトウェア実装。GPU として扱うと CPU パスより遅い。 */
  isFallback: boolean;
  features: readonly string[];
  maxTextureDimension2D: number;
}

const OPTIONAL_FEATURES = ['shader-f16', 'timestamp-query', 'float32-filterable'] as const;

export function describeGpu(adapter: GpuAdapter): GpuProfile {
  const info = adapter.info ?? {};
  return {
    vendor: (info.vendor ?? '').toLowerCase(),
    architecture: (info.architecture ?? '').toLowerCase(),
    description: info.description ?? '',
    isFallback: info.isFallbackAdapter ?? adapter.isFallbackAdapter ?? false,
    features: OPTIONAL_FEATURES.filter((name) => adapter.features.has(name)),
    maxTextureDimension2D: adapter.limits['maxTextureDimension2D'] ?? 8192,
  };
}

/** ベンダー名だけで携帯向け GPU と分かるもの。Apple は Mac と iPhone を区別できないので含めない。 */
const MOBILE_GPU_VENDORS = ['qualcomm', 'arm', 'imagination', 'samsung', 'mediatek'];

/**
 * 表示面積とタッチの有無から、電話サイズの端末かを判定する。
 * 実際の性能は FrameBudgetMonitor が実フレーム間隔で測るので、ここは初期値を決めるだけ。
 */
export function isPhoneClassDevice(
  width: number,
  height: number,
  gpu: GpuProfile | null,
): boolean {
  const touch = navigator.maxTouchPoints > 0;
  if (gpu && MOBILE_GPU_VENDORS.some((vendor) => gpu.vendor.includes(vendor))) return true;
  return touch && Math.min(width, height) < 600;
}
