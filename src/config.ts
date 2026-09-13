import type { AbsorptionTable } from './types/physics.ts';

// 物理パラメータ・定数
export const CS: number = 3;       // 1セル = 3 CSS px
export const DIFF: number = 0.22;  // 毛細管拡散率
export const CAP: number = 0.004;  // 毛細管限界値
export const EVAP: number = 0.99972; // 蒸発率
export const SUB: number = 2;      // サブステップ数
export const VDAMP: number = 0.995; // 速度減衰比
export const AMB: number = 0.085;  // 環流（漂い）の強さ
export const PIGMENT_DENSITY: number = 1.3; // 表示上の顔料濃度

/**
 * 繊維方向の異方性。8近傍の毛細管拡散で、繊維に沿う向きを 1+A、直交する向きを 1-A 倍する。
 * A は紙目ノイズで 0〜FIBER_ANISO の間を取り、滲み足が繊維に沿って伸びる。
 */
export const FIBER_ANISO: number = 0.7;
/** 顔料の定着率。濡れている間の基礎値と、乾くにつれて加わる分。 */
export const DEPOSIT_WET: number = 0.0025;
export const DEPOSIT_DRY: number = 0.05;
/**
 * 縁取り（コーヒーリング）。乾きかけた濡れ際では水分に対して勾配が大きい。
 * そこで定着率を dry · |∇w| / (w + EDGE_WATER_FLOOR) に比例して上げ、
 * 毛細管流で外へ運ばれてきた顔料を縁に留める。
 */
export const EDGE_DEPOSIT: number = 0.05;
export const EDGE_WATER_FLOOR: number = 0.02;
/** 縁取り込みの定着率の上限。1ステップで顔料を取り尽くさないようにする。 */
export const EDGE_RATE_MAX: number = 0.03;

/**
 * 顔料の吸収係数 [R, G, B]
 * 0: 墨 (Sumi), 1: 朱 (Vermilion), 2: 藍 (Indigo)
 */
export const ABS: AbsorptionTable = [
  [2.55, 2.55, 2.30], // 墨
  [0.28, 2.70, 2.95], // 朱
  [2.75, 1.70, 0.50], // 藍
] as const;

/**
 * 画素単位のシェーディング（WebGPU 描画のみ）。格子は 3 px だが、
 * 紙の粒・繊維の毛羽・濡れの艶は画面解像度でシェーダーが作る。
 */
/** 紙の粒状感。顔料は乾くにつれ紙の谷に沈んで粒立つので、光学密度をこの割合で揺らす。 */
export const GRAIN_AMPLITUDE_WET: number = 0.08;
export const GRAIN_AMPLITUDE_DRY: number = 0.2;
/** 繊維に沿った毛羽。密度の読み出し位置を繊維方向へ最大このセル数ずらし、滲みの縁を繊維状にする。 */
export const FIBER_WARP_CELLS: number = 0.75;
/** 濡れた墨の艶。水面の傾きから求めた鏡面反射で、紙色へ寄せる割合の上限。 */
export const GLOSS_STRENGTH: number = 0.32;
