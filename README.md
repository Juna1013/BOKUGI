# 墨戯 - BOKUGI

ブラウザ上で和紙への落墨・にじみ・かすれ・流動・定着を物理シミュレーションで再現する、インタラクティブな水墨画アプリケーションです。

紙に触れると墨が落ち、毛細管現象で繊維を伝って滲み、やがて紙に定着します。描いた作品は縦書きの「作品カード」として PNG に書き出し、共有できます。

## 特徴

- **物理ベースのにじみ表現** — 水分・速度・顔料濃度の各フィールドを持つ格子上で、毛細管拡散・セミラグランジュ移流・蒸発／定着を毎フレーム解きます。拡散は紙の繊維方向に沿った異方性 8 近傍で、滲み足が繊維に沿って伸びます。乾きかけた濡れ際では定着率が上がり、縁が芯より濃くなる縁取りが生まれます。
- **画素解像度の紙の表現（WebGPU）** — 格子は 3 px ですが、フラグメントシェーダーが画面解像度で紙の粒状感（乾くほど顔料が紙の谷に沈んで粒立つ）、繊維に沿った毛羽（滲みの縁が繊維方向にほつれる）、濡れた墨の艶（水面の傾きからの鏡面反射）を加えます。和紙の繊維も物理場の繊維方向に揃えて描くので、目に見える繊維と滲み足の向きが一致します。
- **減法混色による発色** — Lambert-Beer 則に基づき、顔料ごとの吸収係数から透過光を計算。重ね塗りが実際の墨のように濃くなります。
- **伝統色パレット** — 墨・朱・藍の3色。皿に出した絵の具を模した丸型ボタンで切り替えます。
- **筆致の追従** — Pointer Capture でキャンバス外まで確実に追従。素早いドラッグには線補間と流速付与、単発タップには微小な渦流、長押しには継続的な墨の投入を行います。
- **流し書き** — 右下の「流し書き」を入にすると紙に薄く水が張られ、書いた墨が左へ流れながら滲みます。水で洗い流している最中に書いた時の、墨が流れていく気持ちよさをいつでも使えるようにしたものです。流れている間は墨が定着せず、切にすると水が引いて、その時に紙に残っていた墨がその場で落ち着きます。乾いた作品には触れません。
- **水で洗い流す** — 左下のボタンを長押しすると、上端から水の前線が降下し、定着した墨を再溶解させながら下端へ排出します。誤タップで作品を失わないよう、押している間にボタン（タンク）へ水が満ちていき、満水で縁から溢れた水滴が紙に落ちてから流れ始めます。途中で離すと水面が揺れて沈み、「長押しで 水が流れます」と案内します。
- **作品カード** — 和紙層と墨層を合成し、1080×1350 の PNG として書き出します。Web Share API に対応した端末では画像をそのまま共有でき、非対応時は PNG 保存にフォールバックします。作者名の掲載は任意（既定は OFF）で、入力した名前は端末の `localStorage` にのみ保存されます。

## 技術スタック

- TypeScript 5（`strict` に加え `noUncheckedIndexedAccess` / `noUnusedLocals` などを有効化）
- Vite 5
- WebGPU を優先利用（物理はコンピュートシェーダー、描画は格子→テクスチャ→画素シェーディング）し、Canvas 2D API に自動フォールバック
- 実行時依存は [`motion`](https://motion.dev)（UI 演出のみ。物理・描画は自前）
- 書体は Google Fonts の筆文字 [Yuji Syuku](https://fonts.google.com/specimen/Yuji+Syuku) と明朝 [Shippori Mincho](https://fonts.google.com/specimen/Shippori+Mincho)（届かない環境では端末の明朝体に落ちる）

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
| `npm test` | 単体テストを実行（Vitest、`src/**/*.test.ts`） |
| `npm run test:watch` | 単体テストを監視モードで実行 |
| `npm run preview:worker` | ビルド後、Workers ランタイムでローカル確認 |
| `npm run deploy` | ビルド後、Cloudflare Workers へデプロイ |

## デプロイ

MVP は **静的サイト**として Cloudflare Workers の Static Assets で配信します。
サーバーサイドのコード・データベース・API・環境変数はいずれも持ちません。
すべての処理（物理演算・描画・書き出し）はブラウザ内で完結します。

```bash
npx wrangler login   # 初回のみ
npm run deploy
```

設定は [`wrangler.jsonc`](./wrangler.jsonc) にあります。`dist/` を配信するのみで、
バインディング（DB・KV・R2 等）は定義していません。将来データベースを追加する際は、
このファイルにバインディングを追記する形で拡張できます。

なお、作者名の保存（`localStorage`）と作品カードの共有（Web Share API）は
いずれもブラウザ側の機能で、サーバーへの送信は行いません。

## ディレクトリ構成

```bash
index.html                        DOM構造・二層キャンバス・共有ダイアログ
style.css                         縦書きタイポグラフィ、伝統色、mix-blend-mode による乗算合成
src/
├── main.ts                       初期化・キャンバスサイズ調整・アニメーションループ
├── config.ts                     物理パラメータ・顔料の光学吸収係数・画素シェーディングの強さ
├── types/physics.ts              ColorIndex・RGBColor などの型定義
├── physics/
│   ├── Noise.ts                  2D Value Noise 生成
│   ├── FluidGrid.ts              Float32Array による物理場（水分・速度・顔料・繊維方向）
│   ├── FluidSolver.ts            毛細管拡散・定着・移流ソルバー（CPU）
│   └── WebGpuFluidSolver.ts      同じ物理のコンピュートシェーダー実装（16×16 タイル・共有メモリ）
├── renderer/
│   ├── PaperRenderer.ts          和紙テクスチャ（繊維は物理場の向きに揃える）
│   ├── InkRenderer.ts            Canvas 2D フォールバック描画
│   ├── WebGpuInkRenderer.ts      格子→テクスチャ→画素シェーディングの GPU 描画と書き出し読み戻し
│   └── WebGpuTypes.ts            使う範囲だけの WebGPU 型定義
├── quality/
│   ├── DeviceProfile.ts          アダプター情報の読み出しと電話サイズ端末の判定
│   ├── QualityPolicy.ts          セルサイズと描画 DPR の初期値
│   └── FrameBudgetMonitor.ts     実フレーム間隔による DPR・シェーディング段階の自動調整
├── session/
│   ├── SimulationCoordinator.ts  readback・書き出し・リサイズの排他
│   └── AttractController.ts      展示モードの待機画面
├── interaction/
│   ├── InputController.ts        Pointer Events・落墨・筆致の運動量付与
│   ├── RinseController.ts        水洗いの前線波と顔料の再溶解
│   ├── RinseEffects.ts           洗い流すボタンのタンク演出（motion）
│   └── FlowController.ts         流し書きの切り替えと、毎フレームの流れの付与
└── export/
    ├── CardExporter.ts           カード合成と PNG File の生成
    ├── CreatorProfile.ts         作者名の保存・読み出し（localStorage）
    └── ShareCardController.ts    共有ダイアログの制御・Web Share 連携
scripts/
└── fps-bench.mjs                 headless Chrome でのフレームレート計測（docs/frame-rate.md）
```

## 設計上の要点

### 二層キャンバス

背景の和紙（`#paper`）と墨（`#inkLayer`）を別々のキャンバスに分け、CSS の `mix-blend-mode: multiply` で合成しています。和紙は初期化時とリサイズ時のみ描画すればよく、毎フレームの再描画対象は墨層だけに絞られます。

### WebGPU パイプライン

1セル = 3 CSS px（`CS = 3`）で物理場を保持することで計算量を約 1/9 に抑えます。WebGPU 対応ブラウザでは物理と描画のすべてが GPU 上で完結し、フレームごとの CPU ⇄ GPU 転送はありません。

**物理（コンピュート）** — 拡散・定着、移流、落墨などの操作の 3 カーネル。ワークグループは 16×16 の 2D タイルで、拡散はタイル + 縁 1 セル分の必要成分だけを共有メモリ（約 10 KB）に一度載せてから 8 近傍ステンシルを解きます。1D の 64 スレッドで 64 バイトのセル構造体を近傍ごとにグローバル読み出ししていた時に比べ、帯域がボトルネックになりやすいモバイル GPU で効きます。

**描画** — 3 段構成です。
1. `shade`（コンピュート）: 各セルで Lambert–Beer の光学密度を求め、`rgba16float` テクスチャに書く（rgb = 密度、a = 水分）。
2. `bakePaper`（コンピュート）: 紙目・繊維方向・浸透率を別テクスチャに焼く。紙の場が置き換わった時（初期化・リサイズ）だけ。
3. フラグメント: 画素ごとに密度を 4×4 近傍の三次補間（Mitchell–Netravali）で読み、密度（対数）空間で補間してから指数を取る。その上で画面解像度の表現を足す — 繊維方向を 8 方向に量子化した筋ノイズで読み出し位置を繊維に沿ってずらす（毛羽）、紙の微細な高低で光路長を揺らす（粒状感、乾くほど強い）、水面の傾きと紙の微細法線からの鏡面反射で濡れた墨を紙色へ寄せる（艶）。

以前はフラグメントが画素あたり 16 回、64 バイトのセル構造体をストレージバッファから読んでいました。テクスチャ経由にしたのは、モバイル GPU ではテクスチャキャッシュを通る 8 バイトの読み出しの方がはるかに軽いためです。

作品カードの書き出しも同じシェーダーでオフスクリーンテクスチャに描き、`copyTextureToBuffer` で読み戻します。画面と書き出しの見た目が一致し、表示キャンバスの内容が提示後に破棄される問題も避けられます。

WebGPU が使えない環境（および SwiftShader などのソフトウェア実装しか無い環境）では、`ImageData` を再利用する Canvas 2D 描画へ自動フォールバックするため、機能と PNG 書き出しは従来どおり利用できます。

### 端末に合わせた品質

すべての計算は端末内で行うので、使える資源は端末の GPU（iOS Safari では Metal、Android Chrome では Vulkan が WebGPU の下にあります）と CPU です。それを使い切りつつ落ちないよう、次の 2 段で調整します。

- **初期値** — アダプター情報（`adapter.info`）とタッチ・画面サイズから電話サイズの端末を判定し、描画 DPR を 1.5 から始めます。タブレットと PC は 2 から始めます。セルは GPU なら常に 3 px、CPU フォールバック時のみ画面面積とコア数に応じて 3〜5 px に粗くします。
- **実測** — `requestAnimationFrame` の実フレーム間隔を、シミュレーションが動いているフレームだけ平均します。GPU が飽和すると CPU 側の処理時間には現れずフレーム間隔が伸びるので、これを見ます。遅ければ DPR を 0.25 刻みで 1 まで下げ、それでも遅ければ画素シェーディングを簡略化（三次補間→双線形、毛羽と艶を停止）します。速ければ逆順に戻します。

選ばれた経路と品質はコンソールに `BOKUGI: WebGPU (apple / metal-3) tier=phone cell=3px dpr=1.5` のように出るので、Safari / Chrome のリモートインスペクタで端末ごとの挙動を確認できます。URL に `?quality=high|balanced|low`、`?detail=basic` を付けると固定できます。

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
- [docs/exhibition-todo.md](docs/exhibition-todo.md) — 技育博2026に向けた展示体験の実装TODOと本番前チェックリスト。
- [docs/exhibition-spec.md](docs/exhibition-spec.md) — 展示モード、Cloudflare保存基盤、保持期限、ギャラリー公開方針の確定仕様。
- [docs/testing.md](docs/testing.md) — 単体テストの構成と検証内容、実行結果。
- [docs/frame-rate.md](docs/frame-rate.md) — WebGPU / Canvas 2D 各経路のフレームレート実測と計測方法。

## 動作環境

Pointer Events と Canvas 2D に対応したモダンブラウザ（Chrome / Edge / Safari / Firefox の最新版）。WebGPU に対応する Chrome / Edge / Safari（iOS 26 以降の Safari、Android Chrome を含む）では端末の GPU で物理と描画を行い、非対応ブラウザでは Canvas 2D 描画に自動で切り替わります。作品カードの直接共有は Web Share API（`navigator.canShare({ files })`）に対応した端末でのみ有効で、主に iOS / Android が対象です。非対応環境では PNG のダウンロードに切り替わります。
