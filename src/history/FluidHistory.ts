import type { FluidSolver } from '../physics/FluidSolver.ts';
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
  private pendingCheckpoints: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly solver: FluidSolver,
    private readonly maxBytes: number = 64 * 1024 * 1024,
  ) {}

  public get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** 操作開始直前の状態を保存し、新しい操作分岐としてRedoを破棄する。 */
  public checkpoint(): Promise<void> {
    this.clearStack(this.redoStack);
    // GPU版では呼び出した瞬間にcopyコマンドを投入し、その後の筆入力と切り離す。
    const generation = this.generation;
    const snapshot = this.capture();
    this.pendingCheckpoints = this.pendingCheckpoints.then(async () => {
      const captured = await snapshot;
      if (generation !== this.generation) return;
      this.push(this.undoStack, captured);
      this.trimToBudget();
    });
    return this.pendingCheckpoints;
  }

  public async undo(): Promise<boolean> {
    await this.pendingCheckpoints;
    const target = this.undoStack.pop();
    if (!target) return false;
    this.storedBytes -= target.byteLength;
    this.push(this.redoStack, await this.capture());
    this.restore(target);
    return true;
  }

  public async redo(): Promise<boolean> {
    await this.pendingCheckpoints;
    const target = this.redoStack.pop();
    if (!target) return false;
    this.storedBytes -= target.byteLength;
    this.push(this.undoStack, await this.capture());
    this.restore(target);
    return true;
  }

  public clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.storedBytes = 0;
    this.pendingCheckpoints = Promise.resolve();
    this.generation++;
  }

  private async capture(): Promise<FluidSnapshot> {
    const readback = this.solver.readback();
    if (readback) await readback;
    const { gw, gh, N, w, u, v, p, d } = this.solver.grid;
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
    const grid = this.solver.grid;
    if (snapshot.width !== grid.gw || snapshot.height !== grid.gh) {
      this.clear();
      throw new Error('異なる画面サイズの履歴は復元できません');
    }

    grid.w.set(snapshot.water);
    grid.u.set(snapshot.velocityX);
    grid.v.set(snapshot.velocityY);
    for (let c = 0; c < 3; c++) {
      const index = c as ColorIndex;
      grid.p[index].set(snapshot.mobilePigment[index]);
      grid.d[index].set(snapshot.fixedPigment[index]);
      grid.p2[index].set(snapshot.mobilePigment[index]);
    }
    grid.w2.set(snapshot.water);
    this.solver.uploadFromGrid();
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
