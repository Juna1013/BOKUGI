# フレームレート計測 (Frame Rate Measurement)

本書は『墨戯 - BOKUGI』のアニメーションループの実測結果（2026-09-18）と、その計測方法をまとめたものです。再計測は `scripts/fps-bench.mjs` で行えます。

---

## 1. 結論

- **WebGPU 経路**は全条件で 60 fps に張り付き、1 フレームの JavaScript 処理は 0.3 ms 前後。CPU を 4 倍遅くしても落ちない。
- **Canvas 2D 経路**は描画中・滲み中は 60 fps を保つが、**水洗い中だけ約 35 fps** に落ちる。デスクトップ幅（1440×900）では等倍で、モバイル幅（390×844）では CPU 4 倍スロットル時に発生する。
- 水洗いが重いのは、`rinseStep` が紙全体を濡らすことで拡散ステップの対象がストローク周辺から全格子に広がるため（§4）。

## 2. 計測結果

fps と、1 フレームあたりの `requestAnimationFrame` コールバックの CPU 時間（ms、平均）。

| 経路 | 画面 | CPU 倍率 | 描画中 | 滲み中 | 水洗い中 | 洗い後 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| WebGPU | 1440×900 @2x | 1x | 60 / 0.3 | 60 / 0.2 | 60 / 0.2 | 60 / 0.1 |
| WebGPU | 390×844 @3x | 1x | 60 / 0.3 | 60 / 0.3 | 60 / 0.4 | 60 / 0.1 |
| WebGPU | 390×844 @3x | 4x | 60 / 0.1 | 60 / 0.1 | 60 / 0.1 | 60 / 0.1 |
| Canvas 2D | 1440×900 @2x | 1x | 60 / 7.5 | 60 / 8.6 | **35.7 / 27.9** | 60 / 6.0 |
| Canvas 2D | 390×844 @3x | 1x | 60 / 4.4 | 60 / 5.4 | 60 / 8.2 | 60 / 3.5 |
| Canvas 2D | 390×844 @3x | 4x | 60 / 9.4 | 60 / 12.6 | **33.6 / 29.1** | 60 / 5.2 |

Canvas 2D の水洗い中の詳細:

| 条件 | フレーム間隔 p50 / p95 / max (ms) | CPU p50 / p95 / max (ms) | 25 ms 超のフレーム数（4 秒中） |
| :--- | :--- | :--- | :--- |
| 1440×900 @2x, 1x | 33.3 / 33.4 / 50.0 | 28.0 / 35.9 / 36.4 | 94 / 143 |
| 390×844 @3x, 4x | 33.3 / 33.4 / 50.1 | 31.5 / 33.9 / 35.7 | 105 / 135 |

各条件で `selectQuality` が選んだ設定:

| 経路 | 画面 | 品質 | セル | 描画 DPR | 墨キャンバスの実寸 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| WebGPU | 1440×900 @2x | high | 3 px | 2 | 2880×1800 |
| WebGPU | 390×844 @3x | high | 3 px | 2 | 780×1688 |
| Canvas 2D | 1440×900 @2x | balanced | 3 px | 1.5 | 2160×1350 |
| Canvas 2D | 390×844 @3x | balanced | 3 px | 1.5 | 585×1266 |

## 3. 計測方法

### 3.1 環境

- Apple M4（10 コア）、macOS、Google Chrome（headless、`--use-angle=metal`）
- Vite 開発サーバー（`http://localhost:5199`）。`file://` や `about:blank` では WebGPU の adapter が取れない。
- `--enable-unsafe-webgpu --enable-features=WebGPU` で WebGPU 経路。Canvas 2D 経路は **`--disable-features=WebGPU` では無効化できなかった**ため、ページ読み込み前に `navigator.gpu` を `undefined` に定義して強制した。

### 3.2 手順

1. Chrome DevTools Protocol で新しいターゲットを作り、`Emulation.setDeviceMetricsOverride` で画面サイズ・DPR・モバイル判定を、`Emulation.setCPUThrottlingRate` でスロットルを設定する。
2. `Page.addScriptToEvaluateOnNewDocument` で `window.requestAnimationFrame` をラップし、各フレームのタイムスタンプとコールバックの実行時間（`performance.now()` の差）を配列に貯める。`main.ts` の `loop` はこのラップ経由で呼ばれる。
3. ページを開いて 2.5 秒待つ（GPU 初期化と和紙の描画）。
4. 4 つのフェーズを順に記録する。
   - **描画中**: `#inkLayer` に合成 `PointerEvent`（touch、60 Hz の `pointermove`）で画面幅の 70 % を横切る正弦波のストロークを 4 秒。
   - **滲み中**: 入力なしで 4 秒。濡れた墨が拡散している。
   - **水洗い中**: `#rinse` に Enter の `keydown` を送って開始し、0.3 秒後から 4 秒。
   - **洗い後**: 水洗いの記録終了から 6 秒後に 2 秒。紙はまだ濡れているので、乾いた白紙の待機状態ではない。
5. 滲みフェーズの後にスクリーンショットを撮り、両経路とも墨が実際に落ちていることを確認した。

### 3.3 再計測

```bash
npx vite --port 5199 --strictPort &
node scripts/fps-bench.mjs docs/fps-results.json
```

結果は JSON で、シナリオごとに `env`（実際に使われた経路、キャンバス寸法）と `phases`（fps、フレーム間隔と CPU 時間の平均 / p50 / p95 / max、25 ms 超のフレーム数）が入る。スクリーンショットはカレントディレクトリに `shot-<経路>-<画面>-x<倍率>.png` として保存される。

## 4. 水洗いが重い理由

通常の描画では `simStep` は `w[i] > CAP` のセルだけ 8 近傍の拡散を計算するので、コストはストローク周辺の面積に比例します。`rinseStep` は前線より上の全行に注水し `includeViewport` で描画範囲も全面に戻すため、1440×900（格子 480×300 = 14.4 万セル）では

- `simStep` × 2 サブステップ: 全セル × 8 近傍
- `advect`: 全セル
- `rinseStep`: 前線までの全セル
- `InkRenderer.render`: 2160×1350 px の全面

が毎フレーム走り、描画中の 8 ms が 28 ms に跳ね上がります。

`FrameBudgetMonitor` は平均 18 ms 超が 60 フレーム続くと描画 DPR を 0.25 下げる設計なので、実機ではしばらくすると 1.5 → 1.25 → 1.0 と軽くなるはずですが、今回の 4 秒の計測窓ではその効果は確認していません。

前線より下の乾いた行は `w[i] <= CAP` で既に飛ばされているので、コストは前線の進行とともに増え、前線が下端に達して紙全体が濡れた後が最も重くなります。軽くするなら次が候補です。

- 水洗い中だけサブステップ `SUB` を 2 → 1 にする。
- 水洗い中は `InkRenderer` の描画範囲を前線までに限定する。
- 全面が濡れた後の拡散を 1 フレームおきにする（前線の見た目は `advect` と注水で保てる）。

## 5. 注意点

- headless Chrome の `requestAnimationFrame` は 60 Hz 固定。60 fps を超える性能や、ProMotion（120 Hz）端末での挙動は見えない。
- CPU 時間は JavaScript 側の処理だけで、GPU の実行時間は含まない。WebGPU 経路の余裕は GPU 側を計らないと確定できない。
- CPU 4 倍スロットルは実機の代用にすぎない。WebGPU 4x で CPU 時間が逆に小さく出ているのはスロットル時の計時の粗さによるもので、fps の値自体は有効。
- 展示に使う実機（iPad / Android タブレット等）での計測は別途必要。
