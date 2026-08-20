/**
 * 作家プロフィール。
 * カードへの掲載は既定でOFF。ユーザーが明示的にONにした場合のみ描画する。
 */
export interface CreatorProfile {
  displayName: string;
  profileUrl: string;
  showQrCode: boolean;
}

const STORAGE_KEY = 'bokugi.creator-profile.v1';

export const EMPTY_PROFILE: CreatorProfile = {
  displayName: '',
  profileUrl: '',
  showQrCode: false,
};

/**
 * localStorage への保存・読み出しを担う。
 * プライベートブラウジング等で localStorage が使えない場合も落とさない。
 */
export class CreatorProfileStore {
  public load(): CreatorProfile {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...EMPTY_PROFILE };
      return this.normalize(JSON.parse(raw));
    } catch {
      return { ...EMPTY_PROFILE };
    }
  }

  public save(profile: CreatorProfile): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.normalize(profile)));
    } catch {
      // 保存できなくても体験は継続させる
    }
  }

  public clear(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 同上
    }
  }

  private normalize(value: unknown): CreatorProfile {
    if (typeof value !== 'object' || value === null) return { ...EMPTY_PROFILE };
    const source = value as Partial<Record<keyof CreatorProfile, unknown>>;

    return {
      displayName:
        typeof source.displayName === 'string' ? source.displayName.slice(0, 24) : '',
      profileUrl: this.sanitizeUrl(source.profileUrl),
      showQrCode: source.showQrCode === true,
    };
  }

  /** http / https のみ許可する。javascript: 等は捨てる。 */
  private sanitizeUrl(value: unknown): string {
    if (typeof value !== 'string' || value.trim() === '') return '';
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return url.toString();
    } catch {
      return '';
    }
  }
}

/** カードに実際に掲載すべき内容があるか。 */
export function hasPublishableProfile(profile: CreatorProfile): boolean {
  return profile.displayName.trim() !== '' || profile.profileUrl !== '';
}
