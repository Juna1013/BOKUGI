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
 * 顔料の吸収係数 [R, G, B]
 * 0: 墨 (Sumi), 1: 朱 (Vermilion), 2: 藍 (Indigo)
 */
export const ABS: AbsorptionTable = [
  [2.55, 2.55, 2.30], // 墨
  [0.28, 2.70, 2.95], // 朱
  [2.75, 1.70, 0.50], // 藍
] as const;
