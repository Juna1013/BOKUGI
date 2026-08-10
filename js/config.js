// 物理パラメータ・定数
export const CS = 3; // 1セル = 3px
export const DIFF = 0.22; // 毛細管拡散率
export const CAP = 0.004; // 毛細管限界値
export const EVAP = 0.99972; // 蒸発率
export const SUB = 2; // サブステップ
export const VDAMP = 0.995; // 速度の減衰比
export const AMB = 0.085; // 濃い（環流）の強さ

// 吸収係数 [R, G, B]: 0: 墨、1: 朱、2: 藍
export const ABS = [
    [2.55, 2.55, 2.30], // 墨
    [0.28, 2.70, 2.95], // 朱
    [2.75, 1.70, 0.50], // 藍
];
