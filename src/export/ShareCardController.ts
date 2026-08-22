import type { ArtworkSnapshot, CardExporter } from './CardExporter.ts';
import {
  CreatorProfileStore,
  hasPublishableProfile,
  type CreatorProfile,
} from './CreatorProfile.ts';

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;
const CARD_TITLE = '墨戯';
/** style.css の .share-dialog スライドアニメーションと揃える。 */
const SLIDE_DURATION_MS = 420;

export class ShareCardController {
  private readonly store = new CreatorProfileStore();

  private readonly openButton: HTMLButtonElement;
  private readonly dialog: HTMLDialogElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly preview: HTMLImageElement;
  private readonly shareButton: HTMLButtonElement;
  private readonly downloadButton: HTMLButtonElement;
  private readonly status: HTMLElement;

  private readonly nameInput: HTMLInputElement;
  private readonly showProfileToggle: HTMLInputElement;
  private readonly cropX: HTMLInputElement;
  private readonly cropY: HTMLInputElement;
  private readonly resetCropButton: HTMLButtonElement;

  private preparedFile: File | null = null;
  private artwork: ArtworkSnapshot | null = null;
  private previewUrl: string | null = null;
  private profile: CreatorProfile;
  private generating = false;
  private generationPending = false;
  private closing = false;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private cropTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly exporter: CardExporter) {
    this.openButton = this.require<HTMLButtonElement>('shareCardButton');
    this.dialog = this.require<HTMLDialogElement>('shareDialog');
    this.closeButton = this.require<HTMLButtonElement>('shareDialogClose');
    this.preview = this.require<HTMLImageElement>('cardPreview');
    this.shareButton = this.require<HTMLButtonElement>('nativeShareButton');
    this.downloadButton = this.require<HTMLButtonElement>('downloadCardButton');
    this.status = this.require<HTMLElement>('shareStatus');

    this.nameInput = this.require<HTMLInputElement>('creatorName');
    this.showProfileToggle = this.require<HTMLInputElement>('showProfileToggle');
    this.cropX = this.require<HTMLInputElement>('cropX');
    this.cropY = this.require<HTMLInputElement>('cropY');
    this.resetCropButton = this.require<HTMLButtonElement>('resetCropButton');

    this.profile = this.store.load();
    this.applyProfileToForm();
    this.initEvents();
  }

  private require<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) throw new Error(`共有UIの要素が見つかりません: #${id}`);
    return element as T;
  }

  private initEvents(): void {
    this.openButton.addEventListener('click', () => void this.open());
    this.closeButton.addEventListener('click', () => this.requestClose());

    // Esc も閉じるモーションを挟んでから閉じる
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.requestClose();
    });

    // 背景クリックで閉じる
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.requestClose();
    });

    // close() の経路によらず後始末する
    this.dialog.addEventListener('close', () => {
      this.dialog.classList.remove('is-open', 'is-closing');
      this.closing = false;
      this.releasePreview();
    });

    this.shareButton.addEventListener('click', () => void this.sharePreparedFile());
    this.downloadButton.addEventListener('click', () => this.downloadPreparedFile());

    // プロフィールを変更したらカードを作り直す
    this.nameInput.addEventListener('change', () => void this.onProfileChanged());
    this.showProfileToggle.addEventListener('change', () => void this.onProfileChanged());

    const scheduleCrop = (): void => {
      if (this.cropTimer !== undefined) clearTimeout(this.cropTimer);
      this.cropTimer = setTimeout(() => {
        this.cropTimer = undefined;
        void this.generateCard();
      }, 120);
    };
    this.cropX.addEventListener('input', scheduleCrop);
    this.cropY.addEventListener('input', scheduleCrop);
    this.resetCropButton.addEventListener('click', () => {
      this.cropX.value = '0.5';
      this.cropY.value = '0.5';
      void this.generateCard();
    });

    window.addEventListener('pagehide', () => this.releasePreview());
  }

  private applyProfileToForm(): void {
    this.nameInput.value = this.profile.displayName;
    this.showProfileToggle.checked = this.profile.showName;
    this.updateProfileFieldState();
  }

  private updateProfileFieldState(): void {
    this.nameInput.disabled = !this.showProfileToggle.checked;
  }

  private readProfileFromForm(): CreatorProfile {
    return {
      displayName: this.nameInput.value,
      showName: this.showProfileToggle.checked,
    };
  }

  private async onProfileChanged(): Promise<void> {
    this.store.save(this.readProfileFromForm());
    this.profile = this.store.load();

    // 文字数上限などの正規化結果をフォームに反映する
    this.applyProfileToForm();

    if (this.dialog.open) await this.generateCard();
  }

  private async open(): Promise<void> {
    if (this.closeTimer !== undefined) {
      clearTimeout(this.closeTimer);
      this.closeTimer = undefined;
    }
    this.closing = false;
    this.dialog.classList.remove('is-closing');

    if (!this.dialog.open) {
      this.artwork = await this.exporter.captureArtwork();
      this.dialog.showModal();
      // 初期位置（画面左外）を1フレーム描かせてからスライドインさせる
      requestAnimationFrame(() => this.dialog.classList.add('is-open'));
    }

    await this.generateCard();
  }

  /** 左へスライドアウトさせてから dialog を閉じる。 */
  private requestClose(): void {
    if (!this.dialog.open || this.closing) return;

    this.closing = true;
    this.dialog.classList.add('is-closing');
    this.dialog.classList.remove('is-open');

    this.closeTimer = setTimeout(() => {
      this.closeTimer = undefined;
      this.dialog.close();
    }, SLIDE_DURATION_MS);
  }

  /** プレビューを開いた段階で File まで作り切る。 */
  private async generateCard(): Promise<void> {
    if (this.generating) {
      this.generationPending = true;
      return;
    }
    if (!this.artwork) return;
    this.generating = true;

    this.setBusy(true);
    this.setStatus('カードを作成しています…');

    try {
      const file = await this.exporter.createFile({
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        title: CARD_TITLE,
        date: new Date(),
        crop: {
          x: Number(this.cropX.value),
          y: Number(this.cropY.value),
        },
        profile: this.publishableProfile(),
      }, this.artwork);

      this.releasePreview();
      this.preparedFile = file;
      this.previewUrl = URL.createObjectURL(file);
      this.preview.src = this.previewUrl;

      this.setBusy(false);
      this.setStatus(
        this.canShareFiles(file)
          ? '共有するか、PNGで保存できます。'
          : 'この環境では共有シートを使えません。PNGで保存してください。',
      );
    } catch (error) {
      this.preparedFile = null;
      this.setBusy(true);
      this.setStatus(
        error instanceof Error ? error.message : 'カードの作成に失敗しました。',
      );
    } finally {
      this.generating = false;
      if (this.generationPending && this.dialog.open) {
        this.generationPending = false;
        await this.generateCard();
      }
    }
  }

  /** 掲載ONで、かつ載せる内容がある場合だけカードへ渡す。 */
  private publishableProfile(): CreatorProfile | undefined {
    if (!this.profile.showName) return undefined;
    return hasPublishableProfile(this.profile) ? this.profile : undefined;
  }

  private canShareFiles(file: File): boolean {
    return navigator.canShare?.({ files: [file] }) === true;
  }

  private async sharePreparedFile(): Promise<void> {
    if (!this.preparedFile) return;

    const shareData = {
      title: '墨戯 - BOKUGI',
      text: '水墨画を描きました。 #BOKUGI',
      files: [this.preparedFile],
    };

    // 共有先はユーザーが端末の共有シートから選ぶ。Xへの固定はできない。
    if (navigator.canShare?.({ files: shareData.files })) {
      try {
        await navigator.share(shareData);
        this.setStatus('共有シートを開きました。');
      } catch (error) {
        // ユーザーがキャンセルした場合はエラー扱いにしない
        if (error instanceof DOMException && error.name === 'AbortError') return;
        this.setStatus('共有できませんでした。PNGで保存してください。');
      }
      return;
    }

    // デスクトップなど Web Share API 非対応環境
    this.downloadPreparedFile();
  }

  private downloadPreparedFile(): void {
    if (!this.preparedFile || !this.previewUrl) return;

    const link = document.createElement('a');
    link.href = this.previewUrl;
    link.download = this.preparedFile.name;
    link.click();

    // iOS Safari では download 属性が効かず新規タブで開くことがある
    this.setStatus(
      '保存が始まらない場合は、画像を長押しして保存してください。',
    );
  }

  private setBusy(busy: boolean): void {
    this.shareButton.disabled = busy;
    this.downloadButton.disabled = busy;
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }

  /** プレビューに使った Object URL を解放する。 */
  private releasePreview(): void {
    if (this.cropTimer !== undefined) {
      clearTimeout(this.cropTimer);
      this.cropTimer = undefined;
    }
    this.artwork = null;
    this.generationPending = false;
    if (this.previewUrl) {
      URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
    }
    this.preview.removeAttribute('src');
    this.preparedFile = null;
  }
}
