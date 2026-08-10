# 『墨戯 - BOKUGI』 システム設計書 (Design Specification)

本書は、インタラクティブ和紙・水墨画シミュレータWebアプリケーション『墨戯 - BOKUGI』の全体コード構造、物理計算モデル、描画パイプライン、UI/UX設計をリバースエンジニアリングし、体系的にまとめた設計書です。

---

## 1. 概要 (Overview)

### 1.1 プロジェクトコンセプト
『墨戯 - BOKUGI』は、ブラウザ上で和紙への落墨・にじみ・かすれ・流動・乾燥（定着）を物理シミュレーションによって再現する和風デジタルアート体験アプリケーションです。

### 1.2 構成ファイル一覧
| ファイル名 | 役割・概要 |
| :--- | :--- |
| [`index.html`](file:///Users/juna1013/bin/practice/BOKUGI/index.html) | DOM構造、キャンバス（和紙・墨層）、操作UI（色選択、洗い流しボタン、案内テキスト）の定義 |
| [`style.css`](file:///Users/juna1013/bin/practice/BOKUGI/style.css) | 縦書きタイポグラフィ、伝統色パレット、二層キャンバスの乗算合成（`mix-blend-mode`） |
| [`script.js`](file:///Users/juna1013/bin/practice/BOKUGI/script.js) | 二次元格子物理シミュレーション（毛細管現象・流体移流・吸光描画・入力制御）の全ロジック |
| [`docs/design.md`](file:///Users/juna1013/bin/practice/BOKUGI/docs/design.md) | 本設計ドキュメント |

---

## 2. 全体アーキテクチャ (System Architecture)

### 2.1 レイヤー構造とCanvas構成
本アプリケーションは、画面全体を覆う2枚の重なった `<canvas>` エレメントとUIオーバーレイで構成されています。

```
+-------------------------------------------------------+
|  UI Layer (z-index: 3)                                |
|  - タイトル (.title: "墨戯")                            |
|  - 伝統色パレット (.palette: 墨/朱/藍)                  |
|  - 水で洗い流すボタン (.rinse)                          |
+-------------------------------------------------------+
|  Hint Layer (z-index: 2)                              |
|  - 案内テキスト (.hint: "紙に触れてください")              |
+-------------------------------------------------------+
|  Ink Render Layer (z-index: 1, #inkLayer)             |
|  - mix-blend-mode: multiply                           |
|  - 物理シミュレーション結果（墨の挙動）のリアルタイム描画    |
+-------------------------------------------------------+
|  Paper Texture Layer (z-index: 0, #paper)             |
|  - 和紙のベース色、グラデーション、紙繊維ノイズ          |
+-------------------------------------------------------+
```

1. **`#paper` (z-index: 0)**:
   - 和紙のテクスチャ描画専用キャンバス。初期化時（およびリサイズ時）に静的に生成・描画され、毎フレームの再描画を回避して軽量化を図ります。
2. **`#inkLayer` (z-index: 1)**:
   - 墨汁の動的な挙動（拡散・流動・定着）を物理計算し、リアルタイム描画するキャンバス。
   - CSSの `mix-blend-mode: multiply;` を指定し、下層の和紙テクスチャと自然に合成されます。

---

## 3. 物理シミュレーションデータ構造 (Data Structure & Grid System)

### 3.1 解像度とグリッドシステム
計算負荷と視覚的表現力のバランスを取るため、画面ピクセル解像度をそのまま用いず、一定のセルサイズに縮小した2次元物理グリッドを採用しています。

- **`CS = 3`**: 1セル = 3 CSS px 単位で格子を分割。
- **`dpr = Math.min(window.devicePixelRatio || 1, 2)`**: レティナディスプレイ対応（最大2.0倍に制限）。
- **`gw = Math.ceil(W / CS)`**, **`gh = Math.ceil(H / CS)`**: グリッドの幅と高さ。
- **`N = gw * gh`**: 総セル数。

### 3.2 状態変数フィールド (Typed Arrays)
パフォーマンス向上のため、オブジェクト配列ではなく `Float32Array` によるフラットな1次元配列で各種物理場（Scalar / Vector Field）を管理しています。

| 変数名 | 型 | 説明 |
| :--- | :--- | :--- |
| `w` / `w2` | `Float32Array(N)` | 水分量フィールド $W_{x,y}$ （カレント / 次ステップ送出用） |
| `u` / `v` | `Float32Array(N)` | 筆圧・タッチ運動による流速場 $U_{x,y}, V_{x,y}$ |
| `ambU` / `ambV` | `Float32Array(N)` | 和紙のミクロな高低差・繊維による常時流動（漂い）ベクトル場（Curl Noise生成） |
| `perm` | `Float32Array(N)` | 和紙の浸透率・毛細血管係数 $P_{x,y}$ （マルチオクターブValue Noise生成） |
| `grain` | `Float32Array(N)` | 和紙の表面粒子感・粗さ係数 $G_{x,y} \in [0.82, 1.18]$ |
| `p[3]` / `p2[3]` | `Array<Float32Array(N)>` | 水中に浮遊する顔料濃度（0: 墨、1: 朱、2: 藍） |
| `d[3]` | `Array<Float32Array(N)>` | 和紙の繊維に定着・乾燥した顔料濃度（0: 墨、1: 朱、2: 藍） |

---

## 4. アルゴリズムと物理モデル (Algorithms & Physical Models)

### 4.1 和紙テクスチャ & 物理場の生成 (`makeNoise`, `buildFields`)
和紙の複雑な繊維構造と微小な流れを再現するため、手作りの **2D Value Noise** と **Curl Noise** を組み合わせて事前生成しています。

1. **浸透率ノイズ (`perm`)**:
   3つの異なる周波数のValue Noiseを重畳：
   $$\text{val} = 0.45 \cdot N_1 + 0.35 \cdot N_2 + 0.20 \cdot N_3$$
   $$\text{perm}[i] = \min\left(1.4, \text{val}^{1.6} \times 1.9 + 0.12\right)$$
   これにより、墨が染み込みやすい部分と弾きやすい部分のランダムなムラ（滲み足）が形成されます。
2. **環流（漂い）ベクトル場 (`ambU`, `ambV`)**:
   ノイズの回転（Curl）を取ることで、非圧縮性（発散 $\nabla \cdot \mathbf{v} = 0$）の渦流場を計算：
   $$\text{ambU} = \frac{\partial N_f}{\partial y} \cdot \frac{\text{AMB}}{\varepsilon}, \quad \text{ambV} = -\frac{\partial N_f}{\partial x} \cdot \frac{\text{AMB}}{\varepsilon}$$
   これにより、水分の注入時に墨が特定の方向へと自然に漂う挙動を生み出します。

### 4.2 毛細管現象と拡散・定着 (`simStep`)
毎フレーム、サブステップ数（`SUB = 2`）分だけ以下のステップを実行します。

1. **毛細管拡散**:
   水分量 $w_i > \text{CAP} (0.004)$ のセルについて、隣接4近傍（上下左右）との水分差 $\Delta w = w_i - w_j > 0$ を判定。
   移動水量 $f$ を計算：
   $$f = \min\left(\text{DIFF} \cdot \text{perm}_j \cdot \Delta w \cdot (0.6 + 0.8 \cdot \text{rand}()), \, 0.18 \cdot w_i\right)$$
   水分とともに、水中に浮遊している顔料 $p[c]$ も割合 $f_r = f / w_i$ に応じて隣接セルへと送出されます。
2. **蒸発と顔料の定着 (Evaporation & Deposition)**:
   - 水分はステップごとに自然蒸発：$w_i \leftarrow w_i \times \text{EVAP} \ (0.99972)$
   - 紙の乾燥度 $\text{dry} = 1 - \min(6 w_i, 1)$ に応じて定着率 $\text{rate} = 0.003 + 0.05 \cdot \text{dry}^2$ が上昇。
   - 浮遊顔料 $p[c]$ が減少し、定着顔料 $d[c]$ へと変換：
     $$\Delta d = p[c]_i \cdot \text{rate}, \quad d[c]_i \leftarrow d[c]_i + \Delta d, \quad p[c]_i \leftarrow p[c]_i - \Delta d$$
   - 流速の自然減衰：$u_i \leftarrow u_i \cdot \text{VDAMP}, \ v_i \leftarrow v_i \cdot \text{VDAMP} \ (0.995)$

### 4.3 流体移流 (Fluid Advection - `advect`)
筆運動や水洗いで生じるマクロな流速場 $U, V$ に基づき、セミ・ラグランジュ法 (Semi-Lagrangian Method) による格子移流計算を行います。
- 現在の流速 $\mathbf{v} = (u_i + \text{ambU}_i, v_i + \text{ambV}_i) \cdot \min(3.5 w_i, 1)$ を取得。
- 時間を巻き戻した参照位置 $(x - v_x, y - v_y)$ の値を周辺4格子からの双線形補間（Bilinear Interpolation）により算出し、水分 $w$ および浮遊顔料 $p[c]$ を更新します。

### 4.4 光学モデルと減法混色レンダリング (`render`)
光学原理（Lambert-Beerの法則）に基づいた減法混色モデルを採用しています。

1. **実効顔料濃度の算出**:
   $$C^{(c)}_i = 1.15 \cdot d[c]_i + 0.55 \cdot p[c]_i$$
   （定着した顔料の方が色濃く見え、浮遊中の顔料はやや淡く見える効果を付与）
2. **顔料の吸収スペクトル (`ABS`)**:
   | 色名 | Index | 赤(R)吸収係数 | 緑(G)吸収係数 | 青(B)吸収係数 | 光学的特徴 |
   | :--- | :---: | :---: | :---: | :---: | :--- |
   | **墨 (Sumi)** | 0 | 2.55 | 2.55 | 2.30 | 全波長をほぼ均等に強く吸収（無彩色の黒〜グレー） |
   | **朱 (Vermilion)** | 1 | 0.28 | 2.70 | 2.95 | G, Bを強力に吸収し、Rを強く反射（鮮やかな朱色） |
   | **藍 (Indigo)** | 2 | 2.75 | 1.70 | 0.50 | R, Gを強力に吸収し、Bを強く反射（深みのある藍色） |

3. **Lambert-Beer 透過率計算**:
   $$\text{absSum}_k = \sum_{c=0}^2 C^{(c)}_i \cdot \text{ABS}_{c, k} \quad (k \in \{R, G, B\})$$
   $$\text{RGB}_k = 255 \cdot \exp\left( - (\text{absSum}_k + \text{sheen}_i) \cdot \text{grain}_i \right)$$
   ここで $\text{sheen}_i = 0.05 \cdot w_i$ は水分の濡れツヤによる減光、$\text{grain}_i$ は紙の粒子むら表現です。
4. **オフスクリーン描画と拡大適用**:
   `ImageData` にピクセル値を書き込み、低解像度オフスクリーン Canvas (`gridCv`) に `putImageData` した後、高解像度メイン Canvas (`inkCv`) へ `drawImage` で滑らかに転送拡大します。

---

## 5. インタラクション & UI設計 (Interaction & UI)

### 5.1 入力制御 (Pointer Events & Capture)
- **Pointer Capture の活用**:
  `pointerdown` 時に `setPointerCapture(e.pointerId)` を呼び出し、ポインターがキャンバス外に出ても確実にドラッグ追従・リリース検知を行えるように設計されています。
- **落墨 (`drop`) & 筆致追従**:
  - タップ / ドラッグ座標に ガウス分布 $e^{-q^2 / (R^2 \cdot 0.35)}$ に従う水分・顔料を注入。
  - 素早いドラッグ時（`dist > CS`）は、移動距離に応じた線補間落墨と `addVel` による流速の付与を行います。
  - 単発タップ時には `swirl` 関数が起動し、微小な渦状の回転流速を付与して味わいのある滲みを生み出します。
  - 長押し時（`holdT > 20`）は、数フレーム毎に自動的にインクを追加投入します。

### 5.2 水洗い機能 (`rinseStep`)
画面左下の「水で洗い流す」ボタンをクリックすると、和紙全体に上から水波が押し寄せるアニメーションが始まります。
1. 上端から下端に向かって前線 (`frontRow`) が降下し、大量の水分 (`w += 0.13`) と下方流速 (`v += 0.13`) を追加。
2. 既に和紙に定着した墨 $d[c]$ を水に再溶解させて浮遊状態 $p[c]$ に戻します。
3. 画面下端 ($y \ge gh - 3$) に達した水分・顔料は急激に減衰（排出）され、最終的に全フィールドがクリア (`clearAll`) されます。

### 5.3 デザインシステム & ビジュアル表現
- **和風タイポグラフィ**: `Hiragino Mincho ProN`, `Yu Mincho`, `Noto Serif JP` などの明朝体フォントを指定。
- **縦書きレイアウト**: CSS `writing-mode: vertical-rl;` を利用し、タイトル「墨戯」や案内テキスト「紙に触れてください」を風情ある縦書きで表示。
- **伝統色パレット**: 皿に出した絵の具を模した丸型ボタン。アクティブ状態では立体的な2重リング枠線（`box-shadow`）を表示。

---

## 6. アクセシビリティ & パフォーマンス最適化 (Accessibility & Performance)

### 6.1 アクセシビリティ (a11y)
- **ARIA属性**: 色選択パレットに `role="radiogroup"`, ボタンに `aria-label="墨"` / `aria-label="朱"` / `aria-label="藍"` を指定。
- **キーボードナビゲーション**: フォーカス時に明確なアウトライン表示 (`:focus-visible`) を規定。
- **視覚運動の軽減 (`prefers-reduced-motion`)**:
  メディアクエリおよび JS (`matchMedia`) で運動軽減設定を検出。有効時はアニメーションループや無限ブリーズアニメーションを停止し、1回のストローク時に静的シミュレーションを直接完了させて描画します。

### 6.2 パフォーマンス最適化
1. **格子解像度削減 (CS = 3)**: 計算量を $1/9$ に削減しつつ、補間拡大と CSS multiply 合成で滑らかな描画を実現。
2. **型付き配列 (TypedArray) の再利用**: ループ内でのメモリ割り当て（GC発生）を防止するため、配列や ImageData を事前生成して再利用。
3. **描画スキップ条件**: 画面上に水分や進行中の水洗い動作、アクティブなタッチが存在しない場合は `render()` の実行をスキップし、GPU / CPU 負荷を軽減。

---

## 7. リバースエンジニアリングによるコンポーネント構造図

```mermaid
graph TD
    A[ユーザー操作: Pointer / Touch / Click] -->|pointerdown / pointermove| B[入力ハンドラ]
    A -->|Palette Button Click| C[色選択 state: curColor]
    A -->|Rinse Button Click| D[水洗い state: rinsing]

    B -->|drop / addVel / swirl| E[物理フィールド: w, u, v, p]
    D -->|rinseStep: 水波・再溶解| E

    subgraph Simulation Loop [フレーム更新ループ requestAnimationFrame]
        E -->|simStep: 毛細管拡散 & 定着| F[定着フィールド: d, 蒸発: w]
        E -->|advect: Semi-Lagrangian移流| E
    end

    F -->|render: Lambert-Beer 吸光計算| G[Offscreen Canvas: gridCv]
    G -->|drawImage 拡大転送| H[Main Ink Canvas: inkCv]
    H -.->|CSS mix-blend-mode: multiply| I[Paper Canvas: paper]
```
