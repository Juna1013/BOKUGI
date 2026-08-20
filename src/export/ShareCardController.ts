import type { CardExporter } from './CardExporter.ts';
import {
  CreatorProfileStore,
  hasPublishableProfile,
  type CreatorProfile,
} from './CreatorProfile.ts';

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;
const CARD_TITLE = '墨戯';

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
  private readonly urlInput: HTMLInputElement;
  private readonly showProfileToggle: HTMLInputElement;

  private preparedFile: File | null = null;
  private previewUrl: string | null = null;
  private profile: CreatorProfile;
  private generating = false;

  constructor(private readonly exporter: CardExporter) {
    this.openButton = this.require<HTMLButtonElement>('shareCardButton');
    this.dialog = this.require<HTMLDialogElement>('shareDialog');
    this.closeButton = this.require<HTMLButtonElement>('shareDialogClose');
    this.preview = this.require<HTMLImageElement>('cardPreview');
    this.shareButton = this.require<HTMLButtonElement>('nativeShareButton');
    this.downloadButton = this.require<HTMLButtonElement>('downloadCardButton');
    this.status = this.require<HTMLElement>('shareStatus');

    this.nameInput = this.require<HTMLInputElement>('creatorName');
    this.urlInput = this.require<HTMLInputElement>('creatorUrl');
    this.showProfileToggle = this.require<HTMLInputElement>('showProfileToggle');

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
    this.closeButton.addEventListener('click', () => this.dialog.close());

    // Esc や背景クリックで閉じた場合も後始末する
    this.dialog.addEventListener('close', () => this.releasePreview());
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog) this.dialog.close();
    });

    this.shareButton.addEventListener('click', () => void this.sharePreparedFile());
    this.downloadButton.addEventListener('click', () => this.downloadPreparedFile());

    // プロフィールを変更したらカードを作り直す
    for (const input of [this.nameInput, this.urlInput]) {
      input.addEventListener('change', () => void this.onProfileChanged());
    }
    this.showProfileToggle.addEventListener('change', () => void this.onProfileChanged());

    window.addEventListener('pagehide', () => this.releasePreview());
  }

  private applyProfileToForm(): void {
    this.nameInput.value = this.profile.displayName;
    this.urlInput.value = this.profile.profileUrl;
    this.showProfileToggle.checked = this.profile.showQrCode;
    this.updateProfileFieldState();
  }

  private updateProfileFieldState(): void {
    const enabled = this.showProfileToggle.checked;
    this.nameInput.disabled = !enabled;
    this.urlInput.disabled = !enabled;
  }

  private readProfileFromForm(): CreatorProfile {
    return {
      displayName: this.nameInput.value,
      profileUrl: this.urlInput.value,
      showQrCode: this.showProfileToggle.checked,
    };
  }

  private async onProfileChanged(): Promise<void> {
    this.store.save(this.readProfileFromForm());
    this.profile = this.store.load();

    // 入力が不正（http/https以外など）なら正規化結果をフォームに反映する
    this.applyProfileToForm();

    if (this.dialog.open) await this.generateCard();
  }

  private async open(): Promise<void> {
    if (!this.dialog.open) this.dialog.showModal();
    await this.generateCard();
  }

  /** プレビューを開いた段階で File まで作り切る。 */
  private async generateCard(): Promise<void> {
    if (this.generating) return;
    this.generating = true;

    this.setBusy(true);
    this.setStatus('カードを作成しています…');

    try {
      const file = await this.exporter.createFile({
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        title: CARD_TITLE,
        date: new Date(),
        profile: this.publishableProfile(),
      });

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
    }
  }

  /** 掲載ONで、かつ載せる内容がある場合だけカードへ渡す。 */
  private publishableProfile(): CreatorProfile | undefined {
    if (!this.profile.showQrCode) return undefined;
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
    if (this.previewUrl) {
      URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
    }
    this.preview.removeAttribute('src');
    this.preparedFile = null;
  }
}
