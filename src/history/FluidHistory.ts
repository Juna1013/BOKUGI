import type { FluidGrid } from '../physics/FluidGrid.ts';
import type { ColorIndex } from '../types/physics.ts';

interface FluidSnapshot {
  width: number;
  height: number;
  water: Float32Array;
  velocityX: Float32Array;
  velocityY: Float32Array;
  mobilePigment: [Float32Array, Float32Array, Float32Array];
  fixedPigment: [Float32Array, Float32Array, Float32Array];
  byteLength: number;
}

export class FluidHistory {
  private readonly undoStack: FluidSnapshot[] = [];
  private readonly redoStack: FluidSnapshot[] = [];
  private storedBytes = 0;

  constructor(
    private readonly grid: FluidGrid,
    private readonly maxBytes: number = 64 * 1024 * 1024,
  ) {}

  public get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 操作開始直前の状態を保存し、新しい操作分岐としてRedoを破棄する。 */
  public checkpoint(): void {
    this.clearStack(this.redoStack);
    this.push(this.undoStack, this.capture());
    this.trimToBudget();
  }

  public undo(): boolean {
    const target = this.undoStack.pop();
    if (!target) return false;
    this.storedBytes -= target.byteLength;
    this.push(this.redoStack, this.capture());
    this.restore(target);
    return true;
  }

  public redo(): boolean {
    const target = this.redoStack.pop();
    if (!target) return false;
    this.storedBytes -= target.byteLength;
    this.push(this.undoStack, this.capture());
    this.restore(target);
    return true;
  }

  public clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.storedBytes = 0;
  }

  private capture(): FluidSnapshot {
    const { gw, gh, N, w, u, v, p, d } = this.grid;
    return {
      width: gw,
      height: gh,
      water: w.slice(),
      velocityX: u.slice(),
      velocityY: v.slice(),
      mobilePigment: [p[0].slice(), p[1].slice(), p[2].slice()],
      fixedPigment: [d[0].slice(), d[1].slice(), d[2].slice()],
      byteLength: N * 9 * Float32Array.BYTES_PER_ELEMENT,
    };
  }

  private restore(snapshot: FluidSnapshot): void {
    if (snapshot.width !== this.grid.gw || snapshot.height !== this.grid.gh) {
      this.clear();
      throw new Error('異なる画面サイズの履歴は復元できません');
    }

    this.grid.w.set(snapshot.water);
    this.grid.u.set(snapshot.velocityX);
    this.grid.v.set(snapshot.velocityY);
    for (let c = 0; c < 3; c++) {
      const index = c as ColorIndex;
      this.grid.p[index].set(snapshot.mobilePigment[index]);
      this.grid.d[index].set(snapshot.fixedPigment[index]);
      this.grid.p2[index].set(snapshot.mobilePigment[index]);
    }
    this.grid.w2.set(snapshot.water);
  }

  private push(stack: FluidSnapshot[], snapshot: FluidSnapshot): void {
    stack.push(snapshot);
    this.storedBytes += snapshot.byteLength;
  }

  private clearStack(stack: FluidSnapshot[]): void {
    for (const snapshot of stack) this.storedBytes -= snapshot.byteLength;
    stack.length = 0;
  }

  private trimToBudget(): void {
    while (this.storedBytes > this.maxBytes && this.undoStack.length > 1) {
      const oldest = this.undoStack.shift();
      if (oldest) this.storedBytes -= oldest.byteLength;
    }
  }
}
