import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CreatorProfileStore,
  EMPTY_PROFILE,
  hasPublishableProfile,
  SessionCreatorProfileStore,
} from './CreatorProfile.ts';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => { map.delete(k); },
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hasPublishableProfile', () => {
  it('requires a non-blank display name', () => {
    expect(hasPublishableProfile(EMPTY_PROFILE)).toBe(false);
    expect(hasPublishableProfile({ displayName: '   ', showName: true })).toBe(false);
    expect(hasPublishableProfile({ displayName: '墨', showName: false })).toBe(true);
  });
});

describe('CreatorProfileStore', () => {
  it('returns the empty profile when nothing is stored', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(new CreatorProfileStore().load()).toEqual(EMPTY_PROFILE);
  });

  it('round-trips a saved profile', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const store = new CreatorProfileStore();
    store.save({ displayName: '山田', showName: true });
    expect(store.load()).toEqual({ displayName: '山田', showName: true });
    store.clear();
    expect(store.load()).toEqual(EMPTY_PROFILE);
  });

  it('normalizes untrusted stored data', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem(
      'bokugi.creator-profile.v1',
      JSON.stringify({ displayName: 'あ'.repeat(40), showName: 'yes', extra: 1 }),
    );
    const loaded = new CreatorProfileStore().load();
    expect(loaded.displayName).toBe('あ'.repeat(24));
    expect(loaded.showName).toBe(false);
    expect(Object.keys(loaded)).toEqual(['displayName', 'showName']);
  });

  it('falls back to the empty profile on corrupt JSON or wrong types', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('bokugi.creator-profile.v1', '{not json');
    expect(new CreatorProfileStore().load()).toEqual(EMPTY_PROFILE);
    storage.setItem('bokugi.creator-profile.v1', '"just a string"');
    expect(new CreatorProfileStore().load()).toEqual(EMPTY_PROFILE);
    storage.setItem('bokugi.creator-profile.v1', JSON.stringify({ displayName: 42, showName: true }));
    expect(new CreatorProfileStore().load()).toEqual({ displayName: '', showName: true });
  });

  it('survives a localStorage that throws (private browsing)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    });
    const store = new CreatorProfileStore();
    expect(() => store.save({ displayName: 'x', showName: true })).not.toThrow();
    expect(() => store.clear()).not.toThrow();
    expect(store.load()).toEqual(EMPTY_PROFILE);
  });

  it('survives a missing localStorage global', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(new CreatorProfileStore().load()).toEqual(EMPTY_PROFILE);
  });
});

describe('SessionCreatorProfileStore', () => {
  it('keeps the profile in memory only and hands out copies', () => {
    const store = new SessionCreatorProfileStore();
    store.save({ displayName: '展示', showName: true });
    const a = store.load();
    a.displayName = 'changed';
    expect(store.load()).toEqual({ displayName: '展示', showName: true });
    store.clear();
    expect(store.load()).toEqual(EMPTY_PROFILE);
  });

  it('applies the same normalization as the persistent store', () => {
    const store = new SessionCreatorProfileStore();
    store.save({ displayName: 'x'.repeat(30), showName: true });
    expect(store.load().displayName).toHaveLength(24);
  });
});
