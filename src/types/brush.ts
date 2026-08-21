export type BrushKind = 'water' | 'light' | 'dark';

export interface BrushPreset {
  /** 基準投入量に対する水分量。 */
  water: number;
  /** 基準投入量に対する顔料量。0なら水筆。 */
  pigment: number;
  /** 基準筆幅に対する倍率。 */
  radius: number;
  /** 筆が流体へ与える運動量の倍率。 */
  momentum: number;
}
