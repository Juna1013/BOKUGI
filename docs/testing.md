# 単体テスト (Unit Tests)

本書は『墨戯 - BOKUGI』の単体テストの構成と、2026-09-18 時点の実行結果をまとめたものです。

---

## 1. 構成

| 項目 | 内容 |
| :--- | :--- |
| ランナー | [Vitest](https://vitest.dev/) 3 系（Vite 5 に対応する最新系。Vitest 5 は Vite 6 以上を要求する） |
| 設定 | `vitest.config.ts`。`src/**/*.test.ts` を Node 環境で実行 |
| 配置 | 各モジュールの隣に `*.test.ts` を置く。`tsconfig.json` の `include` が `src` なので、`npm run check` の型チェックにも乗る |
| 実行 | `npm test`（一回実行）/ `npm run test:watch`（監視） |

DOM や WebGPU に依存しない層だけを対象にしています。`CardExporter`、`RinseController`、`InputController`、`AttractController`、各レンダラーは対象外です（§4）。

## 2. テスト内容

### 2.1 物理 (`src/physics/`)

**FluidSolver.test.ts**

| 対象 | 検証していること |
| :--- | :--- |
| `fiberWeight` | 8 近傍の重みの合計が繊維の向き θ によらず常に 4。繊維に沿う向きが直交する向きより重い。強さ 0 なら等方 |
| `waterGradient` | 一様場で 0。水平の勾配 1 の場で 1。端では片側差分で、範囲外を読まない |
| `depositionRate` | 常に `DEPOSIT_WET` 以上 `EDGE_RATE_MAX` 以下。乾くほど増える。濡れ際（勾配あり）は芯より大きい。完全に濡れていれば縁取り項が効かない |
| `deposit` | 筆の中心に水と顔料が入り、指定色以外は 0。連打しても水 2.4・顔料 1.5 の上限を超えない。コンテンツ矩形がストロークを含むよう広がる |
| `simStep` | 200 ステップ回しても水の総量が増えない（拡散は保存的、蒸発と切り捨てで減るだけ）。NaN や負値が出ない。浮遊顔料と定着顔料の合計が増えない（1 セル 1e-5 未満の切り捨て分のみ減る）。水が筆の外へ広がる。白紙では何も起きない。いずれ `wet === 0` になり、その後蒸発だけで水が 0 に届く |
| `advect` | 強い速度と渦を与えても有限かつ非負。NaN / Infinity の速度は 0 にリセットされる。速度は減衰する |
| `rinseStep` | 定着顔料が再溶解して減る。コンテンツ矩形が全面に戻る。注水量と速度に上限がある |
| `clearAll` | 水・顔料・速度・`wet` がすべて 0 |
| `resizePreservingState` | 同じ寸法なら `false` を返して何もしない。90×60 → 60×90 の回転で作品が残り、質量が増えない。`shouldApply` が `false` なら中止し `beforeResize` も呼ばない |

**FluidGrid.test.ts**

| 対象 | 検証していること |
| :--- | :--- |
| 生成 | 格子は切り上げでビューポートを覆う。透水率・紙目・繊維の強さ・環流が期待の値域に収まる |
| `gridArea` | 円の内側のセルだけを訪れ、`q2` が距離の二乗と一致。角で範囲外に出ない |
| コンテンツ矩形 | `includeArea` で広がり、ビューポートにクランプ。`restoreContentRect` は 1 セル未満・範囲外にならない。`clearAll` / `includeViewport` で全面に戻る |
| `captureState` / `restoreFittedState` | 同じ寸法なら無損失で往復。保存は別の配列（エイリアスでない）。120×60 → 60×120 の回転で作品が 0.5 倍に縮んで縦中央に収まり、余白は白紙のまま。復元後はダブルバッファにもコピーされる。退化した状態（矩形 0、列数 0）は無視して格子を壊さない |

**Noise.test.ts**: 値域 [0, 1]、同一インスタンスでの決定性、格子点付近の連続性、範囲外座標のクランプ。

### 2.2 品質制御 (`src/quality/`)

**QualityPolicy.test.ts**: WebGPU が使えれば常に `high`。`?quality=` の指定が最優先。CPU 経路ではコア数 4 以下または面積 280 万 px 超で `low`、それ以外は `balanced`。`hardwareConcurrency` 未定義なら 4 コア扱い。セルサイズは面積に応じて 3〜5 px。

**FrameBudgetMonitor.test.ts**: 平均 18 ms 超が 60 フレーム続くと DPR を 0.25 下げる。10 ms 未満が 300 フレーム続くと 0.25 上げる。変更後は 180 フレームのクールダウン。1 未満・上限超にならない。中間帯（10〜18 ms）に入ると連続カウントがリセットされる。単発のスパイクには反応しない。

### 2.3 保存・調停 (`src/export/`, `src/session/`)

**CreatorProfile.test.ts**: `hasPublishableProfile` は空白のみの名前を不可とする。`CreatorProfileStore` は保存と読み出しを往復し、24 文字に切り詰め、`showName` は `true` 以外を `false` にし、余分なキーを落とす。壊れた JSON・型違いは空プロフィールに戻す。`localStorage` が例外を投げても（プライベートブラウジング）、未定義でも落ちない。`SessionCreatorProfileStore` はメモリ内のみで、返す値はコピー。

**SimulationCoordinator.test.ts**: タスクは厳密に直列。失敗しても後続が動く。`busy` 通知は失敗時も `true → false` の順で出る。戻り値の型が保たれる。

## 3. 実行結果（2026-09-18）

```
 Test Files  7 passed (7)
      Tests  70 passed (70)
   Duration  2.4s
```

- `npm run check`（tsc）と `npm run build` も通過。
- 物理テストは `Math.random` を含むため、10 回連続で実行してフレークがないことを確認。
- 実装側のバグは見つかっていない。初回実行で失敗した 7 件はすべてテスト側の誤りで、内訳は次のとおり。
  - `Float32Array` の丸め（`0.3` は `0.30000001192...` になる）。上限値は `Math.fround` で比較する。
  - `FluidSolver.wet` はステップ開始時の濡れセル数で、蒸発後の数とは数セルずれる。
  - `wet === 0` は「全セルが `CAP` 以下」であって水が 0 という意味ではない。そこから蒸発だけで 0 に届くまで数千ステップかかる。
  - `FrameBudgetMonitor` の指数移動平均（係数 0.06）は、30 ms のあと 14 ms を流しても 18 ms を割るまで約 17〜21 フレームかかる。連続カウントのリセットを検証するには、その分を見込んでフレーム数を組む必要がある。

## 4. 対象外と今後の候補

- **DOM 依存の層**（`CardExporter`、`ShareCardController`、`RinseController`、`InputController`、`AttractController`）は happy-dom の追加か、Playwright などの E2E で担保する。
- **WebGPU 経路**（`WebGpuFluidSolver`、`WebGpuInkRenderer`）は tsc では WGSL のエラーを捕まえられない。headless Chrome での視覚回帰テストが候補（[frame-rate.md](frame-rate.md) の計測ハーネスと同じ仕組みが使える）。
- **回帰スナップショット**: `Math.random` を固定シードに差し替えて N ステップ後の状態を保存しておくと、`config.ts` の定数調整で見た目が意図せず変わったことを検知できる。
