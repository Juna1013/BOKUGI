import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectQuality } from './QualityPolicy.ts';
import { isPhoneClassDevice, type GpuProfile } from './DeviceProfile.ts';

function stubBrowser(search: string, cores: number | undefined, touchPoints = 0): void {
  vi.stubGlobal('location', { search });
  vi.stubGlobal('navigator', { hardwareConcurrency: cores, maxTouchPoints: touchPoints });
}

function gpu(vendor = 'apple'): GpuProfile {
  return {
    vendor,
    architecture: '',
    description: '',
    isFallback: false,
    features: [],
    maxTextureDimension2D: 8192,
  };
}

const HIGH = { level: 'high', tier: 'desktop', cellSize: 3, maxRenderDpr: 2, initialRenderDpr: 2 } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isPhoneClassDevice', () => {
  it('recognises mobile GPU vendors regardless of screen size', () => {
    stubBrowser('', 8, 0);
    expect(isPhoneClassDevice(2000, 1200, gpu('qualcomm'))).toBe(true);
    expect(isPhoneClassDevice(2000, 1200, gpu('arm'))).toBe(true);
  });

  it('treats a small touch screen as a phone even when the vendor is unknown', () => {
    stubBrowser('', 8, 5);
    expect(isPhoneClassDevice(390, 844, gpu('apple'))).toBe(true);
    expect(isPhoneClassDevice(390, 844, null)).toBe(true);
  });

  it('does not treat a large touch screen or a desktop without touch as a phone', () => {
    stubBrowser('', 8, 5);
    expect(isPhoneClassDevice(1024, 1366, gpu('apple'))).toBe(false);
    stubBrowser('', 8, 0);
    expect(isPhoneClassDevice(390, 844, gpu('apple'))).toBe(false);
  });
});

describe('selectQuality', () => {
  it('always picks high when WebGPU is available', () => {
    stubBrowser('', 2);
    expect(selectQuality(4000, 3000, gpu())).toEqual(HIGH);
  });

  it('starts phone-class GPU devices at a lower render DPR but keeps the high grid', () => {
    stubBrowser('', 8, 5);
    expect(selectQuality(390, 844, gpu('apple'))).toEqual({ ...HIGH, tier: 'phone', initialRenderDpr: 1.5 });
    stubBrowser('', 8, 0);
    expect(selectQuality(2000, 1200, gpu('qualcomm'))).toEqual({ ...HIGH, tier: 'phone', initialRenderDpr: 1.5 });
  });

  it('honours an explicit ?quality= override before anything else', () => {
    stubBrowser('?quality=low', 16);
    expect(selectQuality(800, 600, gpu())).toEqual({
      level: 'low',
      tier: 'phone',
      cellSize: 5,
      maxRenderDpr: 1,
      initialRenderDpr: 1,
    });
    stubBrowser('?quality=high', 2);
    expect(selectQuality(4000, 3000, null)).toEqual(HIGH);
    stubBrowser('?quality=balanced', 2);
    expect(selectQuality(800, 600, null)).toEqual({
      level: 'balanced',
      tier: 'desktop',
      cellSize: 3,
      maxRenderDpr: 1.5,
      initialRenderDpr: 1.5,
    });
  });

  it('drops to low on CPUs with few cores', () => {
    stubBrowser('', 4);
    const profile = selectQuality(1000, 800, null);
    expect(profile.level).toBe('low');
    expect(profile.tier).toBe('phone');
    expect(profile.maxRenderDpr).toBe(1);
    expect(profile.initialRenderDpr).toBe(1);
  });

  it('drops to low on very large screens even with many cores', () => {
    stubBrowser('', 16);
    expect(selectQuality(2560, 1440, null).level).toBe('low');
  });

  it('uses balanced on a mid-range CPU fallback', () => {
    stubBrowser('', 8);
    expect(selectQuality(1280, 800, null)).toEqual({
      level: 'balanced',
      tier: 'desktop',
      cellSize: 3,
      maxRenderDpr: 1.5,
      initialRenderDpr: 1.5,
    });
  });

  it('assumes 4 cores when hardwareConcurrency is unavailable', () => {
    stubBrowser('', undefined);
    expect(selectQuality(1280, 800, null).level).toBe('low');
  });

  it('coarsens cells as the area grows but never past 5px', () => {
    stubBrowser('', 8);
    expect(selectQuality(600, 400, null).cellSize).toBe(3);
    expect(selectQuality(1600, 1200, null).cellSize).toBe(4);
    expect(selectQuality(2000, 1400, null).cellSize).toBe(4);
    stubBrowser('', 16);
    expect(selectQuality(4000, 3000, null).cellSize).toBe(5);
  });
});
