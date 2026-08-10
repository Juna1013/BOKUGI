import type { NoiseEvaluator } from '../types/physics.ts';

/**
 * 2D Value Noise 生成器
 * @param nx X方向のセル分割数
 * @param ny Y方向のセル分割数
 * @returns 座標 (x, y) における 0.0 ~ 1.0 の補間ノイズ値を返す関数
 */
export function makeNoise(nx: number, ny: number): NoiseEvaluator {
  const g = new Float32Array((nx + 1) * (ny + 1));
  for (let i = 0; i < g.length; i++) {
    g[i] = Math.random();
  }

  return (x: number, y: number): number => {
    x = Math.max(0, Math.min(nx - 0.001, x));
    y = Math.max(0, Math.min(ny - 0.001, y));
    const xi = x | 0;
    const yi = y | 0;
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);

    const i0 = yi * (nx + 1) + xi;
    const a = g[i0] ?? 0;
    const b = g[i0 + 1] ?? 0;
    const c = g[i0 + nx + 1] ?? 0;
    const d = g[i0 + nx + 2] ?? 0;

    return a + sx * (b - a) + sy * ((c - a) + sx * (a - b - c + d));
  };
}
