import { hasPublishableProfile, type CreatorProfile } from './CreatorProfile.ts';

export interface CropPosition {
  x: number;
  y: number;
}

export interface ArtworkSnapshot {
  paperCanvas: HTMLCanvasElement;
  inkCanvas: HTMLCanvasElement;
}

export interface CardOptions {
  width: number;
  height: number;
  title: string;
  date: Date;
  crop: CropPosition;
  /** 掲載がONの場合のみ渡す。未指定なら作品のみのカードになる。 */
  profile?: CreatorProfile;
}

const SERIF = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';

export class CardExporter {
  constructor(
    private readonly paperCanvas: HTMLCanvasElement,
    private readonly getInkCanvas: () => HTMLCanvasElement | Promise<HTMLCanvasElement>,
  ) {}

  /** ダイアログを開いた時点の作品を固定し、調整中の物理変化から切り離す。 */
  public async captureArtwork(): Promise<ArtworkSnapshot> {
    const inkCanvas = await this.getInkCanvas();
    this.assertCanvasSize(this.paperCanvas, inkCanvas);
    return {
      paperCanvas: this.cloneCanvas(this.paperCanvas),
      inkCanvas: this.cloneCanvas(inkCanvas),
    };
  }

  /** カードを合成する。 */
  public compose(options: CardOptions, artwork: ArtworkSnapshot): HTMLCanvasElement {
    this.assertCanvasSize(artwork.paperCanvas, artwork.inkCanvas);

    const output = document.createElement('canvas');
    output.width = options.width;
    output.height = options.height;

    const ctx = output.getContext('2d');
    if (!ctx) throw new Error('カード用Canvasを作成できませんでした');

    ctx.fillStyle = '#f2ede1';
    ctx.fillRect(0, 0, output.width, output.height);

    const frame = {
      x: 72,
      y: 72,
      width: output.width - 144,
      height: output.height - 210,
    };

    const source = this.cropRect(
      artwork.paperCanvas.width,
      artwork.paperCanvas.height,
      frame.width / frame.height,
      options.crop,
    );

    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.x, frame.y, frame.width, frame.height);
    ctx.clip();

    // 和紙
    ctx.drawImage(
      artwork.paperCanvas,
      source.x,
      source.y,
      source.width,
      source.height,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
    );

    // 墨
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(
      artwork.inkCanvas,
      source.x,
      source.y,
      source.width,
      source.height,
      frame.x,
      frame.y,
      frame.width,
      frame.height,
    );

    ctx.restore();

    this.drawDecoration(ctx, options);
    this.drawProfile(ctx, options);
    return output;
  }

  public async createFile(options: CardOptions, artwork: ArtworkSnapshot): Promise<File> {
    const canvas = this.compose(options, artwork);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('PNGの生成に失敗しました'));
      }, 'image/png');
    });

    return new File([blob], `bokugi-${this.dateString(options.date)}.png`, {
      type: 'image/png',
    });
  }

  private assertCanvasSize(
    paperCanvas: HTMLCanvasElement,
    inkCanvas: HTMLCanvasElement,
  ): void {
    if (
      paperCanvas.width !== inkCanvas.width ||
      paperCanvas.height !== inkCanvas.height
    ) {
      throw new Error('和紙Canvasと墨Canvasのサイズが一致していません');
    }
  }

  private cropRect(
    width: number,
    height: number,
    targetRatio: number,
    position: CropPosition,
  ) {
    const sourceRatio = width / height;
    let cropWidth = width;
    let cropHeight = height;

    if (sourceRatio > targetRatio) cropWidth = height * targetRatio;
    else cropHeight = width / targetRatio;

    const maxX = width - cropWidth;
    const maxY = height - cropHeight;
    return {
      x: Math.max(0, Math.min(position.x, 1)) * maxX,
      y: Math.max(0, Math.min(position.y, 1)) * maxY,
      width: cropWidth,
      height: cropHeight,
    };
  }

  private cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
    const clone = document.createElement('canvas');
    clone.width = source.width;
    clone.height = source.height;
    const ctx = clone.getContext('2d');
    if (!ctx) throw new Error('作品スナップショットを作成できませんでした');
    ctx.drawImage(source, 0, 0);
    return clone;
  }

  private drawDecoration(
    ctx: CanvasRenderingContext2D,
    options: CardOptions,
  ): void {
    ctx.fillStyle = '#27262a';
    ctx.font = `52px ${SERIF}`;
    ctx.fillText(options.title, 72, options.height - 78);

    // 落款
    ctx.fillStyle = '#b32b20';
    ctx.fillRect(options.width - 132, options.height - 132, 60, 60);

    ctx.fillStyle = '#f2ede1';
    ctx.font = `30px ${SERIF}`;
    ctx.textAlign = 'center';
    ctx.fillText('戯', options.width - 102, options.height - 91);
    ctx.textAlign = 'start';
  }

  /**
   * 作者名を描く。
   * 掲載がONで、かつ名前が入力されている場合のみ描画する。
   */
  private drawProfile(ctx: CanvasRenderingContext2D, options: CardOptions): void {
    const profile = options.profile;
    if (!profile || !hasPublishableProfile(profile)) return;

    // 落款の左側、タイトル行と同じ高さに収める
    const right = options.width - 156;
    const baseline = options.height - 78;

    ctx.textAlign = 'right';
    ctx.fillStyle = '#27262a';
    ctx.font = `30px ${SERIF}`;
    ctx.fillText(profile.displayName.trim(), right, baseline, right - 260);
    ctx.textAlign = 'start';
  }

  private dateString(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
