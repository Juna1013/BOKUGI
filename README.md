# 墨戯 - BOKUGI

ブラウザ上で和紙への落墨・にじみ・かすれ・流動・定着を物理シミュレーションで再現する、インタラクティブな水墨画アプリケーションです。

紙に触れると墨が落ち、毛細管現象で繊維を伝って滲み、やがて紙に定着します。描いた作品は縦書きの「作品カード」として PNG に書き出し、共有できます。

## 特徴

- **物理ベースのにじみ表現** — 水分・速度・顔料濃度の各フィールドを持つ格子上で、毛細管拡散・セミラグランジュ移流・蒸発／定着を毎フレーム解きます。
- **減法混色による発色** — Lambert-Beer 則に基づき、顔料ごとの吸収係数から透過光を計算。重ね塗りが実際の墨のように濃くなります。
- **伝統色パレット** — 墨・朱・藍の3色。皿に出した絵の具を模した丸型ボタンで切り替えます。
- **筆致の追従** — Pointer Capture でキャンバス外まで確実に追従。素早いドラッグには線補間と流速付与、単発タップには微小な渦流、長押しには継続的な墨の投入を行います。
- **水で洗い流す** — 上端から水の前線が降下し、定着した墨を再溶解させながら下端へ排出します。
- **作品カード** — 和紙層と墨層を合成し、1080×1350 の PNG として書き出します。Web Share API に対応した端末では画像をそのまま共有でき、非対応時は PNG 保存にフォールバックします。作者名の掲載は任意（既定は OFF）で、入力した名前は端末の `localStorage` にのみ保存されます。

## 技術スタック

- TypeScript 5（`strict` に加え `noUncheckedIndexedAccess` / `noUnusedLocals` などを有効化）
- Vite 5
- Canvas 2D API（ライブラリ非依存・追加の実行時依存なし）

## セットアップ

```bash
npm install
npm run dev      # 開発サーバーを起動
```

| スクリプト | 内容 |
| :--- | :--- |
| `npm run dev` | Vite 開発サーバーを起動 |
| `npm run build` | 型チェック（`tsc`）後に `dist/` へビルド |
| `npm run preview` | ビルド結果をローカルで確認 |
| `npm run check` | 型チェックのみ実行（`tsc --noEmit`） |

## ディレクトリ構成

```
index.html                        DOM構造・二層キャンバス・共有ダイアログ
style.css                         縦書きタイポグラフィ、伝統色、mix-blend-mode による乗算合成
src/
├── main.ts                       初期化・キャンバスサイズ調整・アニメーションループ
├── config.ts                     物理パラメータと顔料の光学吸収係数
├── types/physics.ts              ColorIndex・RGBColor などの型定義
├── physics/
│   ├── Noise.ts                  2D Value Noise 生成
│   ├── FluidGrid.ts              Float32Array による物理場（水分・速度・顔料）
│   └── FluidSolver.ts            毛細管拡散・定着・移流ソルバー
├── renderer/
│   ├── PaperRenderer.ts          和紙テクスチャ・繊維の静的描画
│   └── InkRenderer.ts            減法混色計算と低解像度オフスクリーン転送
├── interaction/
│   ├── InputController.ts        Pointer Events・落墨・筆致の運動量付与
│   └── RinseController.ts        水洗いの前線波と顔料の再溶解
└── export/
    ├── CardExporter.ts           カード合成と PNG File の生成
    ├── CreatorProfile.ts         作者名の保存・読み出し（localStorage）
    └── ShareCardController.ts    共有ダイアログの制御・Web Share 連携
```

## 設計上の要点

### 二層キャンバス

背景の和紙（`#paper`）と墨（`#inkLayer`）を別々のキャンバスに分け、CSS の `mix-blend-mode: multiply` で合成しています。和紙は初期化時とリサイズ時のみ描画すればよく、毎フレームの再描画対象は墨層だけに絞られます。

### 格子解像度の削減

1セル = 3 CSS px（`CS = 3`）で物理場を保持することで計算量を約 1/9 に抑え、描画時の補間拡大と乗算合成によって滑らかな見た目を得ています。TypedArray と ImageData は事前に確保して再利用し、ループ内でのメモリ確保を避けています。

### 描画スキップ

画面上に水分が残っておらず、水洗いも進行中でなく、ポインターも接地していない場合は `render()` を実行しません。乾き切った状態では CPU / GPU の負荷がほぼゼロになります。

## アクセシビリティ

- パレットに `role="radiogroup"`、各ボタンに `aria-label` を付与。
- `:focus-visible` によるフォーカスリングを明示。
- `prefers-reduced-motion` を CSS と `matchMedia` の双方で検出。有効時はアニメーションループを停止し、1ストロークごとにシミュレーションを完了させて静的に描画します。
- 共有ダイアログは `<dialog>` 要素を使用し、状態通知は `aria-live="polite"` で読み上げます。

## ドキュメント

- [docs/design.md](docs/design.md) — システム設計書。物理モデル・描画パイプライン・UI 設計の詳細。
- [docs/add-design.md](docs/add-design.md) — 拡張設計方針。PNG カード書き出し、洋の絵の具への顔料モデル一般化、WebGL 移行の検討。

## 動作環境

Pointer Events と Canvas 2D に対応したモダンブラウザ（Chrome / Edge / Safari / Firefox の最新版）。作品カードの直接共有は Web Share API（`navigator.canShare({ files })`）に対応した端末でのみ有効で、主に iOS / Android が対象です。非対応環境では PNG のダウンロードに切り替わります。
