# 『墨戯 - BOKUGI』拡張設計方針（2026年8月版）

対象：技育博 Vol.2（2026年9月19日）出展に向けた機能拡張
エントリー締切：2026年8月26日(水) 23:59 ／ 参加可否連絡：8月28日(金)
作成日：2026年8月14日（締切まで12日）

## 0. 結論

実施順序は次のとおりを推奨します。

| 順位 | 項目 | 作業量目安 | 8/26に間に合うか |
| :---: | :--- | :---: | :--- |
| 1 | レイヤー統合（3.4）＋ PNG カード書き出し | 2〜3日 | 間に合う |
| 2 | 洋の絵の具（顔料モデルの一般化 + 隠蔽性） | 6〜8日 | **3.6 の削減案を前提とすれば間に合う** |
| 3 | WebGL による描画品質向上 | 4〜7日 | 締切後、本番までに実施 |

> **作業量の見積もりについて。** 既存コードを確認した結果、2番目は当初 4〜6日と見積もっていましたが、6〜8日に上方修正しました。理由は次の3点です。いずれも 3.2／3.4／3.5 に詳述します。
>
> 1. `FluidSolver.simStep()` の4近傍処理は3色を手書きで展開しているため、顔料数の一般化にはソルバーの全面書き換えが必要（3.2）
> 2. レイヤー統合には紙テクスチャの格子解像度へのダウンサンプルが必要で、単純な `getImageData` では済まない（3.4）
> 3. パレットUIが `index.html` に静的記述されており、動的生成への置き換えが必要（3.5）
>
> **したがって 3.6 の削減案（水彩紙テクスチャの省略・不透明顔料を2色に限定）は「余裕がなければ」ではなく、最初から前提として計画してください。** 全部入りを狙うと 8/24〜8/25 の実機確認枠を潰すことになります。

順位の根拠は3点です。

1. **依存関係**：洋の絵の具は「顔料の数」というデータ構造を変更します。WebGLシェーダーは顔料数を前提に書くため、顔料モデルを確定させてからWebGLに着手しないと、シェーダーを二度書くことになります。
2. **選考のタイミング**：選考は8/26時点のデモURLに対して行われ、8/28に結果が出ます。一方、デモURLは同じ公開先を更新し続けるため、8/26以降の改善は本番当日には反映されます。つまり **WebGLは選考後に回しても本番での見え方は損なわれません**。
3. **体験時間あたりの効果**：企業担当者が触る時間は数分です。その数分で認識されるのは「触った時の反応」と「結果が手元に残るか」であり、描画品質の差は比較対象がないと気づかれにくい性質があります。PNG書き出しは、体験が終わった後も作品が相手の手元に残るという点で、時間あたりの効果が最も大きいと判断しました。

> 補足：3番目の根拠は「WebGLの価値が低い」という意味ではありません。技術的な深さを説明する材料としてはWebGLが最も強く、当日の口頭説明では中心に据える価値があります。ここで比較しているのは「短時間の体験だけで伝わるか」という軸のみです。

---

## 1. 事前に確認が必要な項目（機能追加より優先）

運営メールが「デモURLが権限等で閲覧できない事例が増えている」と繰り返し注意していました。現状のリポジトリには次の問題があります。

### 1.1 公開設定ファイルが存在しない

リポジトリに `vite.config.js` / `vite.config.ts` が含まれていません。Vite の `base` 設定は既定値が `/` のため、GitHub Pages のサブパス（`https://juna1013.github.io/BOKUGI/`）に配置すると、`index.html` が参照するアセットのパスが `/assets/...` となり、すべて404になります。画面が真っ白になる典型例です。

対応は次のいずれかです。

- **Vercel / Netlify にデプロイする**（推奨）：ルートパス配信になるため `base` 設定が不要。ビルドコマンド `npm run build`、出力ディレクトリ `dist`。
- **GitHub Pages を使う**：`vite.config.ts` を追加し、`base: '/BOKUGI/'` を指定する。

```ts
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/BOKUGI/', // GitHub Pages のサブパス配信時のみ必要
});
```

### 1.2 確認手順

デプロイ後、次の条件で表示を確認してください。開発者の手元では動くが第三者では動かない、という状況を防ぐためです。

1. ブラウザのシークレットウィンドウで開く（GitHubへのログイン状態を除外する）
2. スマートフォンの回線（Wi-Fiではなくモバイル通信）で開く
3. ブラウザのコンソールに404エラーが出ていないことを確認する

### 1.3 README が1行のみ

現在 `README.md` は `# BOKUGI` の1行です。審査担当者はリポジトリを開く可能性があります。最低限、概要・技術構成・起動方法・スクリーンショットを記載してください。`docs/design.md` の内容が充実しているため、README からそこへ誘導するだけでも効果があります。

---

## 2. PNG カード書き出し

### 2.1 目的と要件

体験結果を画像として保存できるようにします。要件を次のように定義します。

- 和紙レイヤーと墨レイヤーを合成した1枚の画像を出力する
- SNS投稿を想定した固定アスペクト比（推奨：4:5 = 1080×1350px）
- 余白・作品タイトル・日付・落款（署名印）を配置し、「カード」として成立させる
- ボタン1回の操作でダウンロードが開始される

### 2.2 実装方式

現状は `#paper`（z-index 0）と `#inkLayer`（z-index 1、CSS `mix-blend-mode: multiply`）の2枚を CSS で合成しています。CSS の合成結果は canvas API から直接取得できないため、書き出し用のオフスクリーンキャンバスで同じ合成を再現します。

Canvas 2D の `globalCompositeOperation = 'multiply'` は CSS の `mix-blend-mode: multiply` と同じ乗算合成を行うため、見た目は一致します。

#### 前提条件：2枚のキャンバスの実ピクセル解像度が一致すること

`drawImage` のソース矩形は **実ピクセル座標**で指定します。現在 `main.ts` の `setupCanvas()` は `#paper` と `#inkLayer` の両方に同じ `W * dpr` / `H * dpr` を設定しているため両者は一致しますが、これは**コード上に明示された保証ではなく、たまたま同じループで設定されているだけ**です。

`InkRenderer.render()` は `ictx.drawImage(gridCv, 0, 0, W, H)` と CSS px 座標で描画しており（`setTransform(dpr, ...)` が掛かっているため結果は正しい）、`dpr` の扱いを将来変更した際に、この前提は無言で壊れます。書き出し画像だけが片側にずれるという、気づきにくい不具合になります。

そのため `CardExporter` は解像度の一致を前提として持たず、**構築時に検証してください**。

```ts
// src/export/CardExporter.ts（新規）

export interface CardOptions {
  width: number;      // 1080
  height: number;     // 1350
  margin: number;     // 余白 px
  title: string;      // 「墨戯」
  date: Date;
}

export class CardExporter {
  constructor(
    private paperCv: HTMLCanvasElement,
    private inkCv: HTMLCanvasElement,
  ) {
    // 切り出し矩形を両キャンバスに流用するため、実ピクセル解像度の一致が前提。
    // dpr の扱いを変更した場合はここで失敗する。
    if (paperCv.width !== inkCv.width || paperCv.height !== inkCv.height) {
      throw new Error(
        `Canvas size mismatch: paper=${paperCv.width}x${paperCv.height}, ` +
        `ink=${inkCv.width}x${inkCv.height}`,
      );
    }
  }

  public compose(opt: CardOptions): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = opt.width;
    out.height = opt.height;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context for card export');

    // 画面の中央から、カードのアスペクト比に合う矩形を切り出す
    const src = this.centerCropRect(opt.width / opt.height);

    // 1. 和紙レイヤー
    ctx.drawImage(
      this.paperCv,
      src.x, src.y, src.w, src.h,
      0, 0, opt.width, opt.height,
    );

    // 2. 墨レイヤーを乗算合成（CSS mix-blend-mode: multiply と等価）
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(
      this.inkCv,
      src.x, src.y, src.w, src.h,
      0, 0, opt.width, opt.height,
    );
    ctx.globalCompositeOperation = 'source-over';

    this.drawFrame(ctx, opt);
    return out;
  }

  private centerCropRect(targetRatio: number) {
    // paperCv は dpr 倍の実ピクセルを持つため、実ピクセル基準で計算する
    const cw = this.paperCv.width;
    const ch = this.paperCv.height;
    const srcRatio = cw / ch;

    if (srcRatio > targetRatio) {
      const w = ch * targetRatio;
      return { x: (cw - w) / 2, y: 0, w, h: ch };
    }
    const h = cw / targetRatio;
    return { x: 0, y: (ch - h) / 2, w: cw, h };
  }

  private drawFrame(ctx: CanvasRenderingContext2D, opt: CardOptions): void {
    // 縦書きは canvas に相当機能がないため、1文字ずつ配置する
    // 落款は朱色の矩形に白抜き文字、または SVG を Image 経由で描画する
  }

  public async download(opt: CardOptions, filename: string): Promise<void> {
    const cv = this.compose(opt);
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/png'));
    if (!blob) throw new Error('Failed to encode PNG');

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}
```

### 2.3 縦書きテキストの描画

canvas には `writing-mode` に相当する機能がありません。1文字ずつ座標を進めて描画します。

```ts
function drawVerticalText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  lineGap = 1.15,
): void {
  ctx.font = `${size}px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text[i]!, x, y + i * size * lineGap);
  }
}
```

明朝体フォントは端末依存です。書き出し画像で確実に同じ字形にするには、Noto Serif JP を Web フォントとして読み込み、`document.fonts.ready` の解決を待ってから描画してください。

### 2.4 注意事項

- **iOS Safari**：`<a download>` が動作せず、画像が新しいタブで開く場合があります。iOS では「長押しで保存してください」という案内を表示するか、`navigator.share` による共有シートを併用してください。
- **解像度**：墨レイヤーは `CS = 3` の低解像度格子を拡大したものです。1080px幅への拡大でぼやけが目立つ場合、書き出し時のみ格子から直接高解像度で再構成する処理が必要になります。まずは拡大のまま試し、実際に見て判断することを推奨します。
- **WebGL移行との関係**：WebGLキャンバスは既定でフレーム描画後にバッファが破棄されるため、`toBlob` が空画像を返します。移行時は `getContext('webgl2', { preserveDrawingBuffer: true })` を指定するか、書き出し直前に描画し同一フレーム内で読み出す必要があります。**この点は3章の実装時に必ず対応してください。**

---

## 3. 洋の絵の具（顔料モデルの一般化）

### 3.1 「色を増やすだけ」との差

`ABS` テーブルに行を追加して色数を増やすだけなら半日で終わります。ただしそれは見た目の変化に留まり、水墨シミュレータとしての性質は変わりません。洋の絵の具を導入する意味は、**画材ごとに物理的な振る舞いが違うことを再現する**点にあります。

| 性質 | 水墨・水彩 | グアッシュ・アクリル・油彩 |
| :--- | :--- | :--- |
| 紙への浸透 | 大きい（毛細管拡散） | 小さい（表面に留まる） |
| 隠蔽性 | 低い（下の色が透ける） | 高い（下の色を覆う） |
| 光学モデル | 減法混色（Lambert-Beer） | アルファ合成（source-over）に近い |
| 乾燥 | 蒸発が支配的 | 定着が速い |
| 重ね塗り | 混色される | 後の塗りが前を覆う |

現行の Lambert-Beer モデルは透明顔料の表現です。不透明顔料はこのモデルでは表現できません（吸収係数をいくら上げても黒に漸近するだけで、白いグアッシュを黒の上に置く表現ができない）。

### 3.2 データ構造の変更

`ColorIndex = 0 | 1 | 2` という固定長型と、`p[3]` / `d[3]` の固定長配列を可変長に一般化します。

```ts
// src/types/physics.ts（変更）

export type PigmentIndex = number;
export type RGBColor = readonly [number, number, number];

export interface Pigment {
  readonly id: string;
  readonly label: string;        // UI表示名
  readonly abs: RGBColor;        // 吸収係数（透明成分）
  readonly body: RGBColor;       // 実体色 0-255（不透明成分）
  readonly opacity: number;      // 隠蔽率 0（完全透明）〜1（完全不透明）
  readonly diffuseScale: number; // 拡散率の倍率（水彩1.0 / アクリル0.15）
  readonly depositScale: number; // 定着率の倍率（水彩1.0 / アクリル4.0）
}

export type Medium = 'sumi' | 'western';
```

```ts
// src/config.ts（変更）

export const PIGMENTS: readonly Pigment[] = [
  // 和：透明顔料
  { id: 'sumi',      label: '墨', abs: [2.55, 2.55, 2.30], body: [30, 28, 26],
    opacity: 0.0, diffuseScale: 1.0, depositScale: 1.0 },
  { id: 'vermilion', label: '朱', abs: [0.28, 2.70, 2.95], body: [200, 60, 40],
    opacity: 0.0, diffuseScale: 1.0, depositScale: 1.0 },
  { id: 'indigo',    label: '藍', abs: [2.75, 1.70, 0.50], body: [30, 60, 120],
    opacity: 0.0, diffuseScale: 1.0, depositScale: 1.0 },

  // 洋：不透明顔料
  { id: 'titanium-white',  label: 'White',  abs: [0.02, 0.02, 0.02], body: [248, 246, 240],
    opacity: 0.95, diffuseScale: 0.15, depositScale: 4.0 },
  { id: 'cadmium-yellow',  label: 'Yellow', abs: [0.10, 0.45, 2.60], body: [242, 190, 40],
    opacity: 0.80, diffuseScale: 0.20, depositScale: 3.5 },
  { id: 'ultramarine',     label: 'Blue',   abs: [2.40, 1.50, 0.20], body: [40,  60, 150],
    opacity: 0.75, diffuseScale: 0.25, depositScale: 3.0 },
] as const;

export const PIGMENT_COUNT = PIGMENTS.length;
```

`FluidGrid` の配列を `Float32Array[]` に変更し、`PIGMENT_COUNT` 個確保します。

```ts
// FluidGrid.resize() 内
this.p  = Array.from({ length: PIGMENT_COUNT }, () => new Float32Array(this.N));
this.p2 = Array.from({ length: PIGMENT_COUNT }, () => new Float32Array(this.N));
this.d  = Array.from({ length: PIGMENT_COUNT }, () => new Float32Array(this.N));
```

### 3.2.1 影響範囲：この変更は局所的ではありません

`ColorIndex` と固定長タプル型は、型定義以外の4ファイルから参照されています。**`types/physics.ts` と `config.ts` を書き換えるだけでは、プロジェクト全体がコンパイルを通りません。** 変更が必要な箇所を漏れなく挙げます。

| ファイル | 現在の記述 | 必要な変更 |
| :--- | :--- | :--- |
| `types/physics.ts` | `ColorIndex = 0 \| 1 \| 2` | 削除（`PigmentIndex = number` へ） |
| 〃 | `AbsorptionTable`（3要素タプル） | 削除（`PIGMENTS` に統合） |
| `physics/FluidGrid.ts` | `p` / `p2` / `d` が3要素タプル型 | `Float32Array[]` へ |
| 〃 | `clearAll()` の `for (c=0; c<3; c++)` | `PIGMENT_COUNT` へ |
| `physics/FluidSolver.ts` | `simStep()` の4近傍ブロック | **全面書き換え（下記）** |
| 〃 | `advect()` の `p2[0..2].set(...)` と swap ループ | ループ化 |
| 〃 | `drop(..., curColor: ColorIndex)` | `PigmentIndex` へ |
| `interaction/RinseController.ts` | `c as 0 \| 1 \| 2` キャスト（3箇所） | キャスト除去 |
| `interaction/InputController.ts` | `curColor: ColorIndex = 0` | `PigmentIndex` へ |
| 〃 | `if (c === 0 \|\| c === 1 \|\| c === 2)` | **下記の注意点を参照** |
| `renderer/InkRenderer.ts` | `abs0`/`abs1`/`abs2` の手動展開 | ループ化（3.3） |

**`InputController.initPalette()` の色番号チェックは静かに壊れます。** 現在の実装は次のとおりです。

```ts
const c = Number(b.dataset['c']);
if (c === 0 || c === 1 || c === 2) { this.curColor = c; }
```

**顔料を6色に増やすと 3〜5 番のボタンが条件を通らず、選択が無言で墨のまま**になります。例外も警告も出ないため、UIだけ見ると「ボタンは光るのに色が変わらない」という症状になります。`Number.isInteger(c) && c >= 0 && c < PIGMENT_COUNT` に置き換えてください。

### 3.2.2 `FluidSolver.simStep()` の書き換え（作業量の主因）

現在の `simStep()` は、上下左右の4近傍それぞれについて **3色分の顔料移動を手書きで展開**しています。

```ts
// 現在：この6行が Left / Right / Top / Bottom の4ブロックに重複している
const p0i = p[0][i] ?? 0, p1i = p[1][i] ?? 0, p2i = p[2][i] ?? 0;
if (p0i > 0) { p2[0][j] += fr * p0i; p2[0][i] -= fr * p0i; }
if (p1i > 0) { p2[1][j] += fr * p1i; p2[1][i] -= fr * p1i; }
if (p2i > 0) { p2[2][j] += fr * p2i; p2[2][i] -= fr * p2i; }
```

顔料数を可変にするには、この12行すべてをループに置き換えます。**これは設計上の都合ではなく、型システム上の強制です。** `tsconfig.json` で `noUncheckedIndexedAccess: true` が有効なため、`p` を `Float32Array[]` にした瞬間に `p[0]` の型が `Float32Array | undefined` となり、現在の `p2[0].set(p[0])` のような記述はすべてコンパイルエラーになります。

書き換え後は次の形になります。近傍4ブロックが同一処理になるため、隣接セルオフセットの配列でまとめることを推奨します。

```ts
// 4近傍を配列化し、ブロックの重複をなくす
const neighbors = [
  { cond: x > 0,      j: i - 1  },
  { cond: x < gw - 1, j: i + 1  },
  { cond: y > 0,      j: i - gw },
  { cond: y < gh - 1, j: i + gw },
];

for (const nb of neighbors) {
  if (!nb.cond) continue;
  const j = nb.j;
  const wj = w[j] ?? 0;
  const dw = wi - wj;
  if (dw <= 0) continue;

  const permJ = perm[j] ?? 1;
  const f = Math.min(DIFF * permJ * dw * (0.6 + Math.random() * 0.8), wi * 0.18);
  w2[j]! += f;
  w2[i]! -= f;

  const fr = f * inv;
  for (let c = 0; c < PIGMENT_COUNT; c++) {
    const pc = p[c]!, p2c = p2[c]!;
    const pci = pc[i] ?? 0;
    if (pci <= 0) continue;
    // 顔料ごとの拡散率を適用（3.5 の物理パラメータ切り替え）
    const move = fr * pci * PIGMENTS[c]!.diffuseScale;
    p2c[j]! += move;
    p2c[i]! -= move;
  }
}
```

**性能への影響を見込んでおいてください。** 内側ループの回数が3から6へ倍増し、`neighbors` 配列の構築がセルごとに発生します（V8 のエスケープ解析で消える可能性はありますが、保証はありません）。ホットループなので、実測して問題が出た場合は次の順で対処します。

1. `neighbors` の配列構築をやめ、4ブロックの展開を維持したまま内側の色ループのみ導入する
2. 顔料数を減らす（3.6 の削減案2）
3. `PIGMENT_COUNT` を定数畳み込みしやすい形（`const enum` 相当）で与える

**3.6 で「不透明顔料を2色に減らす」を推奨している理由の一つがこれです。** 6色は現行の2倍の内側ループを意味します。

### 3.3 描画モデルの変更

透明顔料と不透明顔料を2段階で合成します。

1. 透明成分を Lambert-Beer で計算し、透過色を得る
2. 不透明成分の被覆率を計算し、実体色でアルファ合成する

```ts
// InkRenderer.render() の各セルの処理
// ※ paperR/G/B は 3.4 のレイヤー統合で用意する、格子解像度の紙色配列

// --- 早期リターン：この分岐を「白」のままにしないこと（下記の警告を参照）---
let concSum = 0;
for (let c = 0; c < PIGMENT_COUNT; c++) {
  concSum += (d[c]![i] ?? 0) * 1.15 + (p[c]![i] ?? 0) * 0.55;
}
if (concSum < 0.0004 && wi < 0.01) {
  px[o]     = paperR[i]!;   // 統合前は 255 だった
  px[o + 1] = paperG[i]!;
  px[o + 2] = paperB[i]!;
  px[o + 3] = 255;
  continue;
}

// 1. 透明成分の吸収
let absR = 0, absG = 0, absB = 0;
// 2. 不透明成分の蓄積
let covSum = 0, bodyR = 0, bodyG = 0, bodyB = 0;

for (let c = 0; c < PIGMENT_COUNT; c++) {
  const conc = (d[c]![i] ?? 0) * 1.15 + (p[c]![i] ?? 0) * 0.55;
  if (conc < 1e-5) continue;

  const pg = PIGMENTS[c]!;
  const transparentPart = conc * (1 - pg.opacity);
  absR += transparentPart * pg.abs[0];
  absG += transparentPart * pg.abs[1];
  absB += transparentPart * pg.abs[2];

  // 被覆率：濃度に対して指数的に飽和する
  const cov = pg.opacity * (1 - Math.exp(-conc * 2.2));
  covSum += cov;
  bodyR += cov * pg.body[0];
  bodyG += cov * pg.body[1];
  bodyB += cov * pg.body[2];
}

const sheen = wi * 0.05;
let r = 255 * Math.exp(-(absR + sheen) * gn);
let g = 255 * Math.exp(-(absG + sheen) * gn);
let b = 255 * Math.exp(-(absB + sheen) * gn);

if (covSum > 1e-5) {
  const a = Math.min(covSum, 1);
  // 複数の不透明顔料が重なる場合は被覆率で加重平均した実体色を使う
  r = r * (1 - a) + (bodyR / covSum) * a;
  g = g * (1 - a) + (bodyG / covSum) * a;
  b = b * (1 - a) + (bodyB / covSum) * a;
}
```

> **早期リターン分岐の書き換えを忘れないでください。** 現行の `InkRenderer.render()` には、濃度が閾値未満のセルを白（255,255,255）で塗って `continue` する最適化があります（`c0+c1+c2 < 0.0004 && wi < 0.01` の分岐）。**レイヤー統合（3.4 推奨案）を採ると、この分岐は「白」ではなく「紙の色」を書かなければなりません。** ここを見落とすと、墨も絵の具も置いていない領域がすべて真っ白になり、紙のテクスチャが消えるという分かりやすいが気づきにくい不具合になります。

### 3.4 CSS 乗算合成の問題

**この変更には前提の見直しが必要です。** 現在 `#inkLayer` は CSS `mix-blend-mode: multiply` で和紙レイヤーと合成されています。乗算合成では、白いグアッシュ（RGB 248,246,240）を描いても下の和紙より明るくならないため、**白い絵の具が見えません**。

対応は次のいずれかです。

- **推奨**：`mix-blend-mode` を廃止し、紙のテクスチャを `InkRenderer` 側で読み取って1枚のキャンバスに合成する。`PaperRenderer` の出力を `getImageData` で1回読み出してキャッシュし、各セルの計算に紙の色を含める。PNG書き出しの合成処理も単純になり、後のWebGL移行とも整合します。
- 簡易案：和モードでは乗算、洋モードでは `mix-blend-mode: normal` に切り替え、洋モードのキャンバスには不透明領域のみ `alpha` を持たせる。

推奨案を採ると `CardExporter.compose()` の乗算合成が不要になり、2章の実装が簡素化されます。**そのため、2章と3章を続けて実装する場合は、レイヤー統合を先に済ませてから PNG 書き出しを書く方が手戻りが少なくなります。**

#### 推奨案の実装上の注意：解像度が一致しない

「`getImageData` で1回読み出してキャッシュ」は言葉ほど単純ではありません。**`#paper` と物理格子は解像度が異なります。**

- `#paper` の実ピクセル：`W * dpr × H * dpr`（例：1920×1080 / dpr=2 なら 3840×2160）
- 物理格子：`gw × gh = (W/CS) × (H/CS)`（同条件で 640×360）

単純に `getImageData(0, 0, paper.width, paper.height)` した配列を格子の添字 `i = y * gw + x` でそのまま参照することはできません。**格子解像度へのダウンサンプルが別途必要**で、各格子セルに対応する `dpr * CS × dpr * CS` 画素（上の例では 6×6 画素）の平均、または中心点のサンプリングのいずれかを実装します。

加えて次の2点を見積もりに含めてください。

1. **読み出しコスト**：上の例で `getImageData` は 3840×2160×4 バイト ≈ 33MB の読み出しになります。初回とリサイズ時のみとはいえ、リサイズは `resize` イベントのたびに発生するため、デバウンス（`main.ts` に既存の 200ms タイマーあり）の範囲内で完了することを確認してください。
2. **保持形式**：ダウンサンプル後の紙色は `gw * gh` 要素の配列（R/G/B 各1本、または1本にパックしたもの）として保持し、`InkRenderer.render()` から参照できるようにします。

この作業は「レイヤー統合」の主要コストであり、**PNG書き出しと同時に2日で終わらせる前提（5章）はやや楽観的です。** 日程は 3日を上限に見ておくことを推奨します（5章に反映済み）。

### 3.5 UI と紙の切り替え

- **媒体切り替え**：「和 / 洋」のトグルを追加し、パレットの表示内容を切り替える。
- **パレットの動的生成**：現在の `.palette` は [index.html](../index.html) に `<button class="k" data-c="0">墨</button>` のように**色数分が静的にハードコードされ**、色も [style.css](../style.css) の `.k`/`.r`/`.a` クラスに直書きされています。顔料を可変長にするなら、パレットは `PIGMENTS`（または現在の媒体でフィルタした部分集合）から `InputController` 側で動的に生成する必要があります。これは新規の実装項目であり、3.2.1 の影響範囲表と合わせて作業量に加算してください。

  ```ts
  // 生成例：ボタンの色は body（不透明）または abs から近似したCSS色を使う
  for (const pg of PIGMENTS.filter(p => medium === 'sumi' ? p.opacity === 0 : p.opacity > 0)) {
    const btn = document.createElement('button');
    btn.dataset['c'] = String(PIGMENTS.indexOf(pg));
    btn.style.background = `rgb(${pg.body.join(',')})`;
    btn.setAttribute('aria-label', pg.label);
    paletteEl.appendChild(btn);
  }
  ```

- **下地の切り替え**：`PaperRenderer` に和紙（生成り色・長い繊維・不規則な粒）と水彩紙（白色・短く密な粒・格子状の目）の2種類を持たせる。既存の `render()` を `render(W, H, medium)` に変更し、ベース色・繊維長・粒密度をパラメータ化する。
- **物理パラメータの切り替え**：`FluidSolver` の拡散・定着計算に、顔料ごとの `diffuseScale` / `depositScale` を掛ける（3.2.2 の書き換え後のループに乗せる）。

### 3.6 作業量を抑える場合の削減案

12日という日程を考慮し、締切までに全部が終わらないと判断した場合の削減順序です。

1. 下地（水彩紙テクスチャ）の切り替えを省略し、和紙のまま洋の絵の具を使えるようにする
2. 不透明顔料を3色から2色（White, Blue）に減らす
3. 顔料ごとの物理パラメータ切り替えを省略し、隠蔽性の表現のみ実装する

3まで削ると「色が増えただけ」に近づくため、**削減するとしても1と2まで**を推奨します。

---

## 4. WebGL による描画品質向上

### 4.1 方針

目的は見た目の質の向上と確認しました。したがって **物理計算はCPU（現行の `Float32Array`）のまま維持し、描画のみGPUに移します**。物理計算のGPU化（フィールドをテクスチャに置き、フレームバッファ間でPing-Pongする方式）は、性能が目的でない限り作業量に見合いません。

構成は次のとおりです。

```
[CPU] FluidSolver → Float32Array (w, d[], p[], grain, perm)
   ↓ 毎フレーム texSubImage2D でアップロード
[GPU] gw × gh のテクスチャ群
   ↓ フラグメントシェーダー（全画面1枚のクアッド）
   ↓ Lambert-Beer + 隠蔽合成 + 紙の陰影 + 濡れの反射
[画面] W × H
```

### 4.2 描画品質として得られるもの

Canvas2D では実現できず、シェーダーで実現できる表現です。これが導入の実質的な理由になります。

1. **紙の凹凸による陰影**：`perm` / `grain` を高さ場とみなし、勾配から法線を求めて斜め上からの平行光でライティングする。紙の質感が平面的な模様ではなく凹凸として見えるようになります。
2. **にじみ境界の縁取り（granulation）**：実際の水彩・水墨では、水が蒸発する縁に顔料が集まって輪郭が濃くなります。`d[]` の勾配の大きさに応じて濃度を加算することで再現できます。**この効果は水墨画らしさに直結し、視覚的な効果が最も大きい項目です。**
3. **濡れ領域の反射**：`w` の勾配から法線を求め、鏡面反射項を加える。乾いた部分と濡れた部分の差が出ます。
4. **拡大時の補間品質**：現在は `drawImage` のブラウザ既定補間ですが、シェーダー内でバイキュービック補間や、ノイズを加えた補間を選べます。格子の四角い階段状の輪郭が消えます。
5. **紙の繊維に沿った異方性のにじみ**：繊維方向のベクトル場に沿って濃度をわずかに引き伸ばす。

### 4.3 テクスチャの構成

WebGL2 を前提とします（対応率が十分で、`RGBA16F` がフィルタリング可能なため）。

| テクスチャ | 内部形式 | 内容 |
| :--- | :--- | :--- |
| `texDeposit0` | RGBA16F | d[0], d[1], d[2], w |
| `texFloat0` | RGBA16F | p[0], p[1], p[2], grain |
| `texDeposit1` | RGBA16F | d[3], d[4], d[5], perm（洋の絵の具追加時） |
| `texFloat1` | RGBA16F | p[3], p[4], p[5], 予備 |
| `texPaper` | RGBA8 | `PaperRenderer` の出力（初回とリサイズ時のみ更新） |

顔料6色なら毎フレーム4枚のアップロードです。1920×1080 / CS=3 = 640×360 = 約23万テクセル、RGBA16F で1枚約1.8MB、4枚で約7.4MB/フレーム。60fpsで約440MB/s となり、これは PCIe 帯域に対しては小さい値ですが、統合GPUのモバイル端末では負荷になる可能性があります。

**削減策**：
- `RGBA8` に落とす（濃度を `[0, 4]` の範囲に正規化してから8bit量子化する）。帯域は1/2になりますが、低濃度域に階調段差が出ます。
- 変化のあった領域の矩形のみ `texSubImage2D` で部分更新する。筆の周辺しか変化しないため、実測での削減効果は大きいはずです。

> **`RGBA8` 化する前に `d[]` の上限を決めてください。** 現行の `FluidSolver` は浮遊顔料 `p[c]` を `Math.min(pci + ..., 1.5)` で明示的に clamp していますが（`drop()`）、定着顔料 `d[c]` は蒸発時に加算されるのみで**上限が設定されていません**。`[0, 4]` に正規化する前提を置くなら、この上限値を `simStep()` 側にも明示的に導入し、8bit量子化で飽和しないことを確認してください。

### 4.4 シェーダーの構成（抜粋）

```glsl
#version 300 es
precision highp float;

uniform sampler2D uDeposit0;  // d0,d1,d2,w
uniform sampler2D uFloat0;    // p0,p1,p2,grain
uniform sampler2D uPaper;     // 紙の色
uniform vec2  uGridSize;      // (gw, gh)
uniform vec3  uAbs[6];        // 吸収係数
uniform vec3  uBody[6];       // 実体色（0-1正規化）
uniform float uOpacity[6];    // 隠蔽率
uniform vec3  uLightDir;      // 平行光の方向

in  vec2 vUv;
out vec4 fragColor;

// 濃度場の勾配から法線を求める
vec3 normalFromHeight(sampler2D tex, int ch, vec2 uv, float scale) {
    vec2 texel = 1.0 / uGridSize;
    float hL = texture(tex, uv - vec2(texel.x, 0.0))[ch];
    float hR = texture(tex, uv + vec2(texel.x, 0.0))[ch];
    float hD = texture(tex, uv - vec2(0.0, texel.y))[ch];
    float hU = texture(tex, uv + vec2(0.0, texel.y))[ch];
    return normalize(vec3((hL - hR) * scale, (hD - hU) * scale, 1.0));
}

void main() {
    vec4 dep = texture(uDeposit0, vUv);
    vec4 flo = texture(uFloat0,  vUv);
    float w     = dep.a;
    float grain = flo.a;

    // --- 1. 縁取り（granulation）：定着濃度の勾配が大きい箇所を濃くする ---
    vec2 texel = 1.0 / uGridSize;
    float dc = dep.r + dep.g + dep.b;
    float dx = (texture(uDeposit0, vUv + vec2(texel.x, 0.0)).r
              - texture(uDeposit0, vUv - vec2(texel.x, 0.0)).r);
    float dy = (texture(uDeposit0, vUv + vec2(0.0, texel.y)).r
              - texture(uDeposit0, vUv - vec2(0.0, texel.y)).r);
    float edge = length(vec2(dx, dy)) * 6.0;
    float edgeBoost = 1.0 + clamp(edge, 0.0, 0.6);

    // --- 2. Lambert-Beer + 隠蔽合成 ---
    vec3 absSum = vec3(0.0);
    vec3 bodyAcc = vec3(0.0);
    float covSum = 0.0;
    for (int c = 0; c < 3; c++) {
        float conc = (dep[c] * 1.15 * edgeBoost + flo[c] * 0.55);
        absSum  += conc * (1.0 - uOpacity[c]) * uAbs[c];
        float cov = uOpacity[c] * (1.0 - exp(-conc * 2.2));
        covSum  += cov;
        bodyAcc += cov * uBody[c];
    }

    vec3 paper = texture(uPaper, vUv).rgb;
    vec3 col = paper * exp(-(absSum + w * 0.05) * grain);
    if (covSum > 1e-5) {
        float a = min(covSum, 1.0);
        col = mix(col, bodyAcc / covSum, a);
    }

    // --- 3. 紙の凹凸による陰影 ---
    vec3 nPaper = normalFromHeight(uFloat0, 3, vUv, 1.5);
    float diff = clamp(dot(nPaper, uLightDir), 0.0, 1.0);
    col *= (0.92 + 0.16 * diff);

    // --- 4. 濡れ領域の反射 ---
    if (w > 0.01) {
        vec3 nWet = normalFromHeight(uDeposit0, 3, vUv, 8.0);
        vec3 h = normalize(uLightDir + vec3(0.0, 0.0, 1.0));
        float spec = pow(clamp(dot(nWet, h), 0.0, 1.0), 48.0);
        col += spec * clamp(w * 3.0, 0.0, 1.0) * 0.18;
    }

    fragColor = vec4(col, 1.0);
}
```

GLSL ES 3.00 は `uniform` 配列の動的インデックスを許容しますが、`sampler` 配列は定数インデックスのみです。またループ回数を定数にしておくとドライバによる展開が安定します。シェーダーソースを文字列で組み立てる際に `#define PIGMENT_COUNT 6` を先頭に挿入し、ループ上限をこのマクロにする方式を推奨します。

### 4.5 移行時の注意事項

- **PNG書き出しが壊れます。** WebGLキャンバスは既定でフレーム終了時に描画バッファを破棄するため、`toBlob` が透明画像を返します。`getContext('webgl2', { preserveDrawingBuffer: true })` を指定してください（わずかな性能低下があります）。
- **段階的な移行を推奨します。** `InkRenderer` を `interface Renderer { resize(); render(); }` として抽象化し、`Canvas2DInkRenderer` と `WebGLInkRenderer` の2実装を並存させてください。WebGL初期化に失敗した端末では Canvas2D にフォールバックできます。当日の会場で動かない事態を避けるための保険になります。
- **`mix-blend-mode` は使えません。** 3.4 で述べたレイヤー統合（紙の色をシェーダー内で読む）が前提になります。3章を先に実装しておけば、この作業は不要になります。

---

## 5. 日程

| 期間 | 作業 |
| :--- | :--- |
| 8/14〜8/15 | デプロイ設定の追加と公開確認（1章）、README の整備 |
| 8/16〜8/18 | レイヤー統合（3.4 推奨案。紙色のダウンサンプルを含む）＋ PNG カード書き出し（2章） |
| 8/19〜8/24 | `FluidSolver` のループ化を含む顔料モデルの一般化（3.2）、パレット動的生成（3.5）、洋の絵の具 |
| 8/25 | 実機確認（iOS Safari / Android Chrome / PC）、不具合修正 |
| 8/26 | エントリー提出（23:59締切） |
| 8/28 | 参加可否連絡 |
| 8/29〜9/3 | `Renderer` インターフェースの抽象化と WebGL 実装（4章） |
| 9/4 | 事前キックオフ 19:00-20:00（参加必須） |
| 9/5〜9/14 | WebGL の表現追加（縁取り・陰影・反射）、性能調整 |
| 9/15〜9/18 | 当日デモの動作確認、説明資料の準備 |

8/16〜8/18 でレイヤー統合と PNG 書き出しを同時に行うのは、3.4 で述べた手戻り回避のためです。レイヤー統合には紙色のダウンサンプル実装が伴うため、当初の2日枠から1日延長しました。

**実機確認は1日に圧縮されています。** 3.2.2 のソルバー書き換えと 3.5 のパレット動的生成が見積もりどおりに収まらない場合、最初に削るのは 3.6 の削減案（水彩紙テクスチャ省略・不透明顔料2色）であり、実機確認の日程ではありません。実機確認を削ると「動くはずが当日動かない」という、この設計書が1章で最も警戒しているリスクをそのまま再現することになります。

---

## 6. エントリー記述への反映

運営メールが「役割は肩書きではなく担当箇所を具体的に記載する」よう求めていました。個人開発の場合でも、担当箇所ではなく **実装した技術要素** を具体的に書くと同じ効果が得られます。記載候補を挙げます。

- 毛細管拡散と蒸発・定着を含む2次元流体ソルバーの実装（`Float32Array` による格子計算、セミ・ラグランジュ移流）
- Lambert-Beer の法則に基づく減法混色レンダラーの実装（顔料ごとの吸収スペクトル定義）
- 和紙の浸透率・繊維方向を表現する Value Noise / Curl Noise 生成器の実装
- `prefers-reduced-motion` 対応を含むアクセシビリティ設計
- 低解像度格子（1セル3px）と描画スキップ条件による性能最適化

「墨のインタラクティブサイト」という説明だけでは、内部が物理シミュレーションであることが伝わりません。**上記のうち1つ目と2つ目は必ず記載してください。**

---

## 7. 検討したが推奨しない選択肢

判断の記録として残します。

| 選択肢 | 推奨しない理由 |
| :--- | :--- |
| 物理計算のGPU化（GPGPU） | 目的が見た目の質であり、性能上の必要性が確認されていない。フレームバッファのPing-Pong実装は作業量が大きく、デバッグも難しい。格子解像度を上げたくなった時点で改めて検討する。 |
| `ABS` に行を追加するだけの洋絵の具 | 隠蔽性という画材の本質的な差が表現されず、色数が増えただけになる。物理シミュレータという作品の主張と整合しない。 |
| PNG書き出しを `html2canvas` で実装 | canvas の内容は `html2canvas` では正しく取得できず、CSS の `mix-blend-mode` も再現されない。canvas API で直接合成する方が確実かつ高速。 |
| WebGPU の採用 | 2026年時点で Safari の対応が限定的であり、当日の会場でどの端末が使われるか制御できない。WebGL2 の方が確実。 |
