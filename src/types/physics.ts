// 伝統色インデックス (0: 墨, 1: 朱, 2: 藍)
export type ColorIndex = 0 | 1 | 2;

// 光学吸光係数ベクトル [R, G, B]
export type RGBColor = readonly [number, number, number];

// 顔料の光学吸収係数テーブル
export type AbsorptionTable = readonly [RGBColor, RGBColor, RGBColor];

// 格子の円形領域走査コールバック関数型
export type GridAreaCallback = (
  index: number,
  dx: number,
  dy: number,
  distanceSq: number
) => void;

// 2D ノイズ評価関数型
export type NoiseEvaluator = (x: number, y: number) => number;
