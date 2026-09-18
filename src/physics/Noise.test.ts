import { describe, expect, it } from 'vitest';
import { makeNoise } from './Noise.ts';

describe('makeNoise', () => {
  it('returns values within [0, 1] across the whole domain', () => {
    const noise = makeNoise(8, 6);
    for (let y = 0; y <= 6; y += 0.25) {
      for (let x = 0; x <= 8; x += 0.25) {
        const v = noise(x, y);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is deterministic for the same instance', () => {
    const noise = makeNoise(5, 5);
    expect(noise(1.3, 2.7)).toBe(noise(1.3, 2.7));
  });

  it('returns the lattice value exactly at integer coordinates', () => {
    const noise = makeNoise(4, 4);
    // 格子点上では補間の重みが 0 なので、隣接する格子点の影響を受けない。
    // 少しずらした点と比べて連続していることも確認する。
    const at = noise(2, 2);
    expect(Math.abs(noise(2.001, 2.001) - at)).toBeLessThan(0.01);
  });

  it('clamps coordinates outside the lattice instead of reading out of bounds', () => {
    const noise = makeNoise(3, 3);
    expect(Number.isFinite(noise(-10, -10))).toBe(true);
    expect(Number.isFinite(noise(100, 100))).toBe(true);
    expect(noise(-10, 0)).toBe(noise(0, 0));
    expect(noise(100, 100)).toBe(noise(3 - 0.001, 3 - 0.001));
  });
});
