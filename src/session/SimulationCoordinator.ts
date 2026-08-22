/**
 * GPU readback、Undo/Redo、リサイズを直列化する小さな排他キュー。
 * 失敗した処理があっても、後続処理を止めない。
 */
export class SimulationCoordinator {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onBusyChange: (busy: boolean) => void) {}

  public runExclusive<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.onBusyChange(true);
      try {
        return await task();
      } finally {
        this.onBusyChange(false);
      }
    });

    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
