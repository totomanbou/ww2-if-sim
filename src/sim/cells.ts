/**
 * Shares of a country's army per transit map cell (combat.deployArmies). A cell is row × 1000 + column of a
 * cellDeg-degree grid, or -1 for states without coordinates. Map-like (get / set / has / delete / size / keys /
 * iteration) but backed by typed arrays, since the deployment is updated for every country and cell each week.
 * Cells are indexed 0 (= cell -1) and 1 + row × perRow + column; `list` holds the indices present, in a fixed
 * (deterministic) order: new cells are appended and a deleted cell is replaced by the last one.
 */
export class CellShares {
  readonly perRow: number;
  readonly rows: number;
  /** Value per index (0 when absent). */
  readonly value: Float64Array;
  /** Position in `list` per index, -1 when absent. */
  readonly pos: Int32Array;
  /** Indices present. */
  readonly list: number[] = [];

  constructor(cellDeg: number) {
    this.perRow = Math.round(360 / cellDeg);
    this.rows = Math.round(180 / cellDeg);
    const n = this.perRow * this.rows + 1;
    this.value = new Float64Array(n);
    this.pos = new Int32Array(n).fill(-1);
  }

  /** Index of a cell, -1 when outside the grid. */
  index(cell: number): number {
    if (cell === -1) return 0;
    const row = Math.floor(cell / 1000), col = cell - row * 1000;
    if (row < 0 || row >= this.rows || col < 0 || col >= this.perRow) return -1;
    return 1 + row * this.perRow + col;
  }

  /** Cell of an index. */
  cell(i: number): number {
    if (i === 0) return -1;
    const row = Math.floor((i - 1) / this.perRow);
    return row * 1000 + (i - 1 - row * this.perRow);
  }

  get size(): number {
    return this.list.length;
  }

  get(cell: number): number | undefined {
    const i = this.index(cell);
    return i >= 0 && this.pos[i] >= 0 ? this.value[i] : undefined;
  }

  has(cell: number): boolean {
    const i = this.index(cell);
    return i >= 0 && this.pos[i] >= 0;
  }

  set(cell: number, v: number): this {
    const i = this.index(cell);
    if (i < 0) throw new RangeError(`cell ${cell} is outside the grid`);
    this.setAt(i, v);
    return this;
  }

  setAt(i: number, v: number): void {
    if (this.pos[i] < 0) {
      this.pos[i] = this.list.length;
      this.list.push(i);
    }
    this.value[i] = v;
  }

  delete(cell: number): boolean {
    const i = this.index(cell);
    if (i < 0 || this.pos[i] < 0) return false;
    this.deleteAt(i);
    return true;
  }

  deleteAt(i: number): void {
    const p = this.pos[i];
    if (p < 0) return;
    const last = this.list.pop()!;
    if (last !== i) {
      this.list[p] = last;
      this.pos[last] = p;
    }
    this.pos[i] = -1;
    this.value[i] = 0;
  }

  clear(): void {
    for (const i of this.list) {
      this.pos[i] = -1;
      this.value[i] = 0;
    }
    this.list.length = 0;
  }

  *keys(): IterableIterator<number> {
    for (const i of this.list.slice()) yield this.cell(i);
  }

  *entries(): IterableIterator<[number, number]> {
    for (const i of this.list.slice()) yield [this.cell(i), this.value[i]];
  }

  [Symbol.iterator](): IterableIterator<[number, number]> {
    return this.entries();
  }
}
