import QRCode from 'qrcode';
import { hasPublishableProfile, type CreatorProfile } from './CreatorProfile.ts';

export interface CardOptions {
  width: number;
  height: number;
  title: string;
  date: Date;
  /** 掲載がONの場合のみ渡す。未指定なら作品のみのカードになる。 */
  profile?: CreatorProfile;
}

const SERIF = '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';
const QR_SIZE = 132;

export class CardExporter {
  constructor(
    private readonly paperCanvas: HTMLCanvasElement,
    private readonly inkCanvas: HTMLCanvasElement,
  ) {}

  /**
   * カードを合成する。
   * プロフィールのQRコード生成が非同期のため、描画そのものは compose() に閉じ、
   * QR画像は呼び出し側で事前に用意して渡す。
   */
  public compose(options: CardOptions, qrImage?: CanvasImageSource): HTMLCanvasElement {
    this.assertCanvasSize();

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

    const source = this.centerCrop(frame.width / frame.height);

    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.x, frame.y, frame.width, frame.height);
    ctx.clip();

    // 和紙
    ctx.drawImage(
      this.paperCanvas,
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
      this.inkCanvas,
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
    this.drawProfile(ctx, options, qrImage);
    return output;
  }

  public async createFile(options: CardOptions): Promise<File> {
    const qrImage = await this.createQrImage(options.profile);
    const canvas = this.compose(options, qrImage);

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

  /**
   * プロフィールURLのQRコードを生成する。
   * 掲載OFF・URL未設定・生成失敗のいずれでも undefined を返し、カード生成自体は続行する。
   */
  private async createQrImage(
    profile: CreatorProfile | undefined,
  ): Promise<HTMLImageElement | undefined> {
    if (!profile?.showQrCode || profile.profileUrl === '') return undefined;

    try {
      const dataUrl = await QRCode.toDataURL(profile.profileUrl, {
        width: QR_SIZE * 2,
        margin: 1,
        color: { dark: '#27262a', light: '#f2ede1' },
      });

      return await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('QRコードの読み込みに失敗しました'));
        image.src = dataUrl;
      });
    } catch {
      return undefined;
    }
  }

  private assertCanvasSize(): void {
    if (
      this.paperCanvas.width !== this.inkCanvas.width ||
      this.paperCanvas.height !== this.inkCanvas.height
    ) {
      throw new Error('和紙Canvasと墨Canvasのサイズが一致していません');
    }
  }

  private centerCrop(targetRatio: number) {
    const width = this.paperCanvas.width;
    const height = this.paperCanvas.height;
    const sourceRatio = width / height;

    if (sourceRatio > targetRatio) {
      const croppedWidth = height * targetRatio;
      return {
        x: (width - croppedWidth) / 2,
        y: 0,
        width: croppedWidth,
        height,
      };
    }

    const croppedHeight = width / targetRatio;
    return {
      x: 0,
      y: (height - croppedHeight) / 2,
      width,
      height: croppedHeight,
    };
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
   * 作者名・プロフィールURL・QRコードを描く。
   * 掲載がONで、かつ表示する内容がある場合のみ描画する。
   */
  private drawProfile(
    ctx: CanvasRenderingContext2D,
    options: CardOptions,
    qrImage?: CanvasImageSource,
  ): void {
    const profile = options.profile;
    if (!profile || !hasPublishableProfile(profile)) return;

    // 落款の左側、タイトル行の上に収める
    const right = options.width - 156;
    const baseline = options.height - 78;

    if (qrImage) {
      ctx.drawImage(
        qrImage,
        right - QR_SIZE,
        options.height - 72 - QR_SIZE,
        QR_SIZE,
        QR_SIZE,
      );
    }

    const textRight = qrImage ? right - QR_SIZE - 24 : right;
    ctx.textAlign = 'right';

    const displayName = profile.displayName.trim();
    if (displayName !== '') {
      ctx.fillStyle = '#27262a';
      ctx.font = `30px ${SERIF}`;
      ctx.fillText(displayName, textRight, baseline - 34, textRight - 260);
    }

    if (profile.profileUrl !== '') {
      ctx.fillStyle = 'rgba(39, 38, 42, 0.55)';
      ctx.font = `21px ${SERIF}`;
      ctx.fillText(
        this.shortenUrl(profile.profileUrl),
        textRight,
        baseline,
        textRight - 260,
      );
    }

    ctx.textAlign = 'start';
  }

  /** カードには読みやすさ優先で scheme を落とした形を載せる。 */
  private shortenUrl(url: string): string {
    return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }

  private dateString(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
