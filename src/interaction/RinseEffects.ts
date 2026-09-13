import { animate, motionValue, stagger } from 'motion';

type Controls = ReturnType<typeof animate>;

/** 水面の波の高さ（style.css の .rinse__wave と揃える）。空の時はこの分も下げて隠す。 */
const WAVE_HEIGHT_PX = 8;

/** 水位 0（空）〜1（満水）を translateY に写す。 */
const levelToTranslate = (level: number): string => {
  const empty = 1 - level;
  return `translateY(calc(${(empty * 100).toFixed(2)}% + ${(empty * WAVE_HEIGHT_PX).toFixed(2)}px))`;
};

/**
 * 「水で洗い流す」ボタンをタンクに見立てた演出。
 * 長押しで水位が上がり、満水で縁から溢れ、その水が紙の上端から前線として降りる。
 * 物理（rinseStep）は RinseController が進め、ここは DOM の見た目だけを受け持つ。
 */
export class RinseEffects {
  private readonly area: HTMLElement | null;
  private readonly button: HTMLElement | null;
  private readonly water: HTMLElement | null;
  private readonly wave: HTMLElement | null;
  private readonly spill: HTMLElement | null;
  private readonly front: HTMLElement | null;

  /** タンクの水位。0 が空、1 が満水。 */
  private readonly level = motionValue(0);
  private levelAnim: Controls | null = null;
  private waveLoop: Controls | null = null;
  private frontAnim: Controls | null = null;
  /** 前線の帯は 1 回の洗い流しで一度だけ通り過ぎる。 */
  private frontState: 'hidden' | 'shown' | 'passed' = 'hidden';

  constructor() {
    this.area = document.querySelector<HTMLElement>('.rinse-area');
    this.button = document.getElementById('rinse');
    this.water = this.button?.querySelector<HTMLElement>('.rinse__water') ?? null;
    this.wave = this.button?.querySelector<HTMLElement>('.rinse__wave') ?? null;
    this.spill = this.area?.querySelector<HTMLElement>('.rinse-spill') ?? null;
    this.front = document.getElementById('rinseFront');

    this.level.on('change', (v) => {
      if (this.water) this.water.style.transform = levelToTranslate(v);
    });
    if (this.water) this.water.style.transform = levelToTranslate(0);
  }

  /** 押している間、水位を一定の速さで満水まで上げる。 */
  public fill(durationMs: number): void {
    this.levelAnim?.stop();
    this.startWave();
    this.setWaveAmplitude(0.6 + this.level.get() * 0.8, 0.2);
    this.levelAnim = animate(this.level, 1, {
      duration: durationMs / 1000,
      ease: 'linear',
    });
  }

  /** 満ちる前に離した。水面がひとつ揺れてから沈む。 */
  public slosh(): void {
    this.levelAnim?.stop();
    this.setWaveAmplitude(2.2, 0.12);
    this.levelAnim = animate(this.level, 0, {
      type: 'spring',
      stiffness: 70,
      damping: 8,
      mass: 1,
      onComplete: () => this.settleWave(),
    });
  }

  /** 満水。縁から水滴がこぼれ、紙に落ちて波紋を作る。 */
  public overflow(): void {
    this.levelAnim?.stop();
    this.level.set(1);
    this.setWaveAmplitude(1.8, 0.1);
    this.spawnDrops();
  }

  /**
   * 毎フレーム、rinseStep の進み具合を見た目に写す。
   * 前線は sweepFrames で下端に着き、注水は totalFrames-100 まで続く。
   */
  public rinseProgress(t: number, sweepFrames: number, totalFrames: number): void {
    const pouring = Math.max(1, totalFrames - 100);
    const drained = Math.min(1, t / pouring);
    this.level.set(1 - drained);

    const front = this.front;
    if (!front) return;
    if (this.frontState === 'passed') return;
    const sweep = Math.min(1, t / sweepFrames);
    if (this.frontState === 'hidden') {
      this.frontState = 'shown';
      this.frontAnim?.stop();
      this.frontAnim = animate(front, { opacity: [0, 1] }, { duration: 0.35 });
    }
    // 帯の高さ（14vh）ぶん上から始め、下端を越えて抜けていく
    front.style.transform = `translateY(${(-14 + sweep * 114).toFixed(2)}vh)`;
    if (t >= sweepFrames + 20) {
      this.hideFront();
      this.frontState = 'passed';
    }
  }

  /** 流し終わった、または途中で止めた。残った水と前線を片付ける。 */
  public finishRinse(): void {
    this.levelAnim?.stop();
    if (this.level.get() <= 0.01) {
      // 注水を終えてタンクが空のまま流し終えた
      this.level.set(0);
      this.settleWave();
    } else {
      this.levelAnim = animate(this.level, 0, {
        duration: 0.6,
        ease: 'easeOut',
        onComplete: () => this.settleWave(),
      });
    }
    this.hideFront();
    this.frontState = 'hidden';
  }

  /** 即座に初期状態へ（reduced motion や無効化時）。 */
  public reset(): void {
    this.levelAnim?.stop();
    this.levelAnim = null;
    this.level.set(0);
    this.settleWave();
    this.hideFront();
    this.frontState = 'hidden';
    this.spill?.replaceChildren();
  }

  private startWave(): void {
    if (this.waveLoop || !this.wave) return;
    this.waveLoop = animate(
      this.wave,
      { x: ['0%', '-50%'] },
      { duration: 1.4, ease: 'linear', repeat: Infinity },
    );
  }

  private settleWave(): void {
    if (this.level.get() > 0.01) return;
    this.waveLoop?.stop();
    this.waveLoop = null;
    this.setWaveAmplitude(0.6, 0.3);
  }

  private setWaveAmplitude(scaleY: number, duration: number): void {
    if (!this.wave) return;
    animate(this.wave, { scaleY }, { duration, ease: 'easeOut' });
  }

  private hideFront(): void {
    const front = this.front;
    if (!front || this.frontState !== 'shown') return;
    this.frontAnim?.stop();
    this.frontAnim = animate(front, { opacity: 0 }, { duration: 0.5 });
  }

  /** 縁の右上から数粒、右へ弧を描いて紙に落ち、波紋を残す。 */
  private spawnDrops(): void {
    const { spill, button } = this;
    if (!spill || !button) return;
    const rimX = button.offsetLeft + button.offsetWidth - 1;
    const rimY = button.offsetTop + 2;
    const drops: HTMLElement[] = [];
    const ripples: HTMLElement[] = [];
    const landings: Array<{ dx: number; dy: number }> = [];

    for (let i = 0; i < 4; i++) {
      const dx = 10 + i * 9 + Math.random() * 4;
      const dy = 22 + i * 12 + Math.random() * 6;
      landings.push({ dx, dy });

      const drop = document.createElement('span');
      drop.className = 'rinse-drop';
      drop.style.left = `${rimX}px`;
      drop.style.top = `${rimY}px`;
      const ripple = document.createElement('span');
      ripple.className = 'rinse-ripple';
      ripple.style.left = `${rimX + dx}px`;
      ripple.style.top = `${rimY + dy}px`;
      spill.append(drop, ripple);
      drops.push(drop);
      ripples.push(ripple);
    }

    const delay = stagger(0.07);
    drops.forEach((drop, i) => {
      const { dx, dy } = landings[i] ?? { dx: 0, dy: 0 };
      animate(
        drop,
        {
          x: [0, dx * 0.55, dx],
          y: [0, -7, dy],
          opacity: [0, 1, 1, 0],
          scale: [0.6, 1, 0.8],
        },
        { duration: 0.5, delay: delay(i, drops.length), ease: ['easeOut', 'easeIn'] },
      );
    });
    ripples.forEach((ripple, i) => {
      animate(
        ripple,
        { scale: [0.2, 1], opacity: [0.55, 0] },
        { duration: 0.8, delay: 0.42 + delay(i, ripples.length), ease: 'easeOut' },
      );
    });
    setTimeout(() => {
      for (const el of [...drops, ...ripples]) el.remove();
    }, 1600);
  }
}
