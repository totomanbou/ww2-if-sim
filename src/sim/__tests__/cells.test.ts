import { describe, expect, it } from "vitest";
import { CellShares } from "../cells";

const cellIndices = [
  [-1, 0],
  [0, 1],
  [71, 72],
  [1000, 73],
  [35071, 2592],
] as const;

const outsideCells = [36000, 36071, 72, 1072, 35072, -1000, -929, -2, -999];

function expectConsistentPositions(store: CellShares): void {
  expect(new Set(store.list).size).toBe(store.size);
  for (let k = 0; k < store.size; k++) {
    expect(store.pos[store.list[k]]).toBe(k);
  }
}

describe("CellShares", () => {
  it("creates a 72-column, 36-row grid with a sentinel slot", () => {
    const store = new CellShares(5);
    expect(store.perRow).toBe(72);
    expect(store.rows).toBe(36);
    expect(store.value).toBeInstanceOf(Float64Array);
    expect(store.pos).toBeInstanceOf(Int32Array);
    expect(store.value).toHaveLength(2593);
    expect(store.pos).toHaveLength(2593);
  });

  it.each(cellIndices)("round-trips cell %i through index %i", (cell, index) => {
    const store = new CellShares(5);
    expect(store.index(cell)).toBe(index);
    expect(store.cell(index)).toBe(cell);
    expect(store.cell(store.index(cell))).toBe(cell);
    expect(store.index(store.cell(index))).toBe(index);
  });

  it.each(outsideCells)("rejects cell %i outside the grid", (cell) => {
    const store = new CellShares(5);
    expect(store.index(cell)).toBe(-1);
    expect(store.get(cell)).toBeUndefined();
    expect(store.has(cell)).toBe(false);
    expect(() => store.set(cell, 10)).toThrow(RangeError);
    expect(store.size).toBe(0);
  });

  it("starts empty, including zeroed values and absent positions", () => {
    const store = new CellShares(5);
    expect(store.size).toBe(0);
    expect(store.list).toEqual([]);
    expect([...store.keys()]).toEqual([]);
    expect([...store.entries()]).toEqual([]);
    expect([...store]).toEqual([]);
    expect(store.value.every((value) => value === 0)).toBe(true);
    expect(store.pos.every((position) => position === -1)).toBe(true);
    for (const [cell] of cellIndices) {
      expect(store.get(cell)).toBeUndefined();
      expect(store.has(cell)).toBe(false);
    }
  });

  it("sets, overwrites, and chains without treating zero as absent", () => {
    const store = new CellShares(5);
    expect(store.set(-1, 0)).toBe(store);
    expect(store.get(-1)).toBe(0);
    expect(store.has(-1)).toBe(true);
    expect(store.size).toBe(1);
    expect(store.set(1000, 25).set(35071, -7)).toBe(store);
    expect(store.get(1000)).toBe(25);
    expect(store.get(35071)).toBe(-7);
    expect(store.has(1000)).toBe(true);
    expect(store.has(35071)).toBe(true);
    expect(store.size).toBe(3);
    const originalList = store.list.slice();
    expect(store.set(1000, 0)).toBe(store);
    expect(store.get(1000)).toBe(0);
    expect(store.has(1000)).toBe(true);
    expect(store.size).toBe(3);
    expect(store.list).toEqual(originalList);
    expectConsistentPositions(store);
  });

  it("deletes present cells, swaps the last entry into a middle slot, and ignores absent cells", () => {
    const store = new CellShares(5);
    const cells = [-1, 0, 71, 1000, 35071];
    for (const cell of [...cells, ...outsideCells]) {
      expect(store.delete(cell)).toBe(false);
    }
    cells.forEach((cell, k) => store.set(cell, k + 1));
    const originalList = store.list.slice();
    for (const cell of [1, ...outsideCells]) {
      expect(store.delete(cell)).toBe(false);
    }
    expect(store.list).toEqual(originalList);
    expect(store.size).toBe(5);

    expect(store.delete(71)).toBe(true);
    expect(store.list).toEqual([0, 1, 2592, 73]);
    expect(store.pos[2592]).toBe(2);
    expectConsistentPositions(store);
    for (const cell of [-1, 0, 1000, 35071]) {
      expect(store.has(cell)).toBe(true);
      expect(store.get(cell)).toBe(cells.indexOf(cell) + 1);
    }
    for (const cell of [71, -1, 1000, 35071, 0]) {
      if (cell !== 71) expect(store.delete(cell)).toBe(true);
      expect(store.get(cell)).toBeUndefined();
      expect(store.has(cell)).toBe(false);
      expect(store.value[store.index(cell)]).toBe(0);
      expect(store.pos[store.index(cell)]).toBe(-1);
      expect(store.delete(cell)).toBe(false);
      expectConsistentPositions(store);
    }
    expect(store.size).toBe(0);
    expect(store.list).toEqual([]);
  });

  it("sets, overwrites, deletes, and reinserts present indices like the cell-based methods", () => {
    const indexed = new CellShares(5);
    const keyed = new CellShares(5);
    const expectSameStore = () => {
      expect(indexed.size).toBe(keyed.size);
      expect([...indexed]).toEqual([...keyed]);
      expect(indexed.list).toEqual(keyed.list);
      expect(indexed.value).toEqual(keyed.value);
      expect(indexed.pos).toEqual(keyed.pos);
      expectConsistentPositions(indexed);
    };
    for (const [cell, index] of cellIndices) {
      indexed.setAt(index, index + 10);
      keyed.set(cell, index + 10);
      expectSameStore();
      indexed.setAt(index, 0);
      keyed.set(cell, 0);
      expectSameStore();
    }
    for (const [cell, index] of [cellIndices[2], cellIndices[0], cellIndices[4]]) {
      indexed.deleteAt(index);
      expect(keyed.delete(cell)).toBe(true);
      expect(indexed.get(cell)).toBeUndefined();
      expect(indexed.has(cell)).toBe(false);
      expect(indexed.value[index]).toBe(0);
      expect(indexed.pos[index]).toBe(-1);
      expectSameStore();
      indexed.setAt(index, -10);
      keyed.set(cell, -10);
      expectSameStore();
    }
  });

  it("leaves other cells intact when deleteAt receives an absent valid index", () => {
    const store = new CellShares(5).set(-1, 10).set(1000, 20);
    store.deleteAt(store.index(71));
    expect(store.size).toBe(2);
    expect([...store]).toEqual([[-1, 10], [1000, 20]]);
    expect(store.has(71)).toBe(false);
    expectConsistentPositions(store);
  });

  it("clears all previous cells and backing values and can be reused", () => {
    const store = new CellShares(5);
    for (const [cell, index] of cellIndices) store.set(cell, index + 10);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.list).toEqual([]);
    expect([...store]).toEqual([]);
    for (const [cell] of cellIndices) {
      expect(store.get(cell)).toBeUndefined();
      expect(store.has(cell)).toBe(false);
    }
    expect(store.value.every((value) => value === 0)).toBe(true);
    expect(store.pos.every((position) => position === -1)).toBe(true);
    store.clear();
    expect(store.set(35071, 0).set(-1, 9)).toBe(store);
    expect(store.size).toBe(2);
    expect(store.get(35071)).toBe(0);
    expect(store.has(35071)).toBe(true);
    expect(store.get(-1)).toBe(9);
    expect([...store]).toEqual([[35071, 0], [-1, 9]]);
    expectConsistentPositions(store);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.value.every((value) => value === 0)).toBe(true);
    expect(store.pos.every((position) => position === -1)).toBe(true);
  });

  it("returns keys, entries, and default iteration in list order after a swap deletion", () => {
    const store = new CellShares(5).set(1000, 10).set(-1, 20).set(71, 30).set(35071, 40);
    store.delete(-1);
    expect(store.list).toEqual([73, 2592, 72]);
    expect([...store.keys()]).toEqual([1000, 35071, 71]);
    expect([...store.entries()]).toEqual([[1000, 10], [35071, 40], [71, 30]]);
    expect([...store]).toEqual([...store.entries()]);
  });

  it("visits the original keys when deleting every cell during keys iteration", () => {
    const store = new CellShares(5).set(1000, 1).set(-1, 2).set(71, 3).set(35071, 4);
    const originalCells = [1000, -1, 71, 35071];
    const visited: number[] = [];
    expect(() => {
      for (const cell of store.keys()) {
        visited.push(cell);
        expect(store.delete(cell)).toBe(true);
      }
    }).not.toThrow();
    expect(visited).toEqual(originalCells);
    expect(store.size).toBe(0);
  });

  it.each(["entries", "iterator"] as const)("snapshots cell order for %s during deletion", (method) => {
    const store = new CellShares(5).set(1000, 1).set(-1, 2).set(71, 3).set(35071, 4);
    const visited: [number, number][] = [];
    const iterator = method === "entries" ? store.entries() : store[Symbol.iterator]();
    for (const entry of iterator) {
      visited.push(entry);
      expect(store.delete(entry[0])).toBe(true);
    }
    expect(visited).toEqual([[1000, 1], [-1, 2], [71, 3], [35071, 4]]);
    expect(store.size).toBe(0);
  });

  it("matches a Map after each of 500 seeded random set/delete operations", () => {
    const store = new CellShares(5);
    const reference = new Map<number, number>();
    const touched = new Set<number>();
    let seed = 0x12345678;
    const next = (limit: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 0x100000000) * limit);
    };
    // Revisit a random pool so the sequence exercises overwrites and successful deletions.
    const cells: number[] = cellIndices.map(([cell]) => cell);
    for (let k = 0; k < 64; k++) cells.push(next(36) * 1000 + next(72));
    for (let operation = 0; operation < 500; operation++) {
      const cell = cells[next(cells.length)];
      touched.add(cell);
      if (next(3) !== 0) {
        const value = next(201) - 100;
        expect(store.set(cell, value)).toBe(store);
        reference.set(cell, value);
      } else {
        expect(store.delete(cell)).toBe(reference.delete(cell));
      }
      expect(store.size).toBe(reference.size);
      for (const touchedCell of touched) {
        expect(store.get(touchedCell)).toBe(reference.get(touchedCell));
        expect(store.has(touchedCell)).toBe(reference.has(touchedCell));
      }
      expectConsistentPositions(store);
    }
  });

  it("indexes a 10-degree grid with 36 columns and 18 rows", () => {
    const store = new CellShares(10);
    expect(store.perRow).toBe(36);
    expect(store.rows).toBe(18);
    expect(store.value).toHaveLength(649);
    expect(store.pos).toHaveLength(649);
    for (const [cell, index] of [[-1, 0], [0, 1], [35, 36], [1000, 37], [17035, 648]]) {
      expect(store.index(cell)).toBe(index);
      expect(store.cell(index)).toBe(cell);
      store.set(cell, index + 1);
      expect(store.get(cell)).toBe(index + 1);
      expect(store.value[index]).toBe(index + 1);
    }
    for (const cell of [36, 1036, 17036, 18000, -1000, -2]) {
      expect(store.index(cell)).toBe(-1);
    }
    expect(store.size).toBe(5);
    expectConsistentPositions(store);
  });
});
