import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectQuality } from './QualityPolicy.ts';

function stubBrowser(search: string, cores: number | undefined): void {
  vi.stubGlobal('location', { search });
  vi.stubGlobal('navigator', { hardwareConcurrency: cores });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('selectQuality', () => {
  it('always picks high when WebGPU is available', () => {
    stubBrowser('', 2);
    expect(selectQuality(4000, 3000, true)).toEqual({ level: 'high', cellSize: 3, maxRenderDpr: 2 });
  });

  it('honours an explicit ?quality= override before anything else', () => {
    stubBrowser('?quality=low', 16);
    expect(selectQuality(800, 600, true).level).toBe('low');
    stubBrowser('?quality=high', 2);
    expect(selectQuality(4000, 3000, false).level).toBe('high');
    stubBrowser('?quality=balanced', 2);
    expect(selectQuality(800, 600, false)).toEqual({ level: 'balanced', cellSize: 3, maxRenderDpr: 1.5 });
  });

  it('drops to low on CPUs with few cores', () => {
    stubBrowser('', 4);
    const profile = selectQuality(1000, 800, false);
    expect(profile.level).toBe('low');
    expect(profile.maxRenderDpr).toBe(1);
  });

  it('drops to low on very large screens even with many cores', () => {
    stubBrowser('', 16);
    expect(selectQuality(2560, 1440, false).level).toBe('low');
  });

  it('uses balanced on a mid-range CPU fallback', () => {
    stubBrowser('', 8);
    expect(selectQuality(1280, 800, false)).toEqual({ level: 'balanced', cellSize: 3, maxRenderDpr: 1.5 });
  });

  it('assumes 4 cores when hardwareConcurrency is unavailable', () => {
    stubBrowser('', undefined);
    expect(selectQuality(1280, 800, false).level).toBe('low');
  });

  it('coarsens cells as the area grows but never past 5px', () => {
    stubBrowser('', 8);
    expect(selectQuality(600, 400, false).cellSize).toBe(3);
    expect(selectQuery(1600, 1200).cellSize).toBe(4);
    expect(selectQuery(2000, 1400).cellSize).toBe(4);
    stubBrowser('', 16);
    expect(selectQuality(4000, 3000, false).cellSize).toBe(5);

    function selectQuery(w: number, h: number) {
      return selectQuality(w, h, false);
    }
  });
});
