type Ring = number[][];

function bounds(rings: Ring[]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const r of rings) for (const [x, y] of r) { w = Math.min(w, x); s = Math.min(s, y); e = Math.max(e, x); n = Math.max(n, y); }
  return [w, s, e, n];
}

function contains([x, y]: number[], rings: Ring[]): boolean {
  let inside = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const turn = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Area overlap of planar polygons, with even-odd holes. Merely touching edges need not select a neighbouring state. */
export function polygonsOverlap(a: Ring[], b: Ring[]): boolean {
  const ab = bounds(a), bb = bounds(b);
  if (ab[2] < bb[0] || ab[0] > bb[2] || ab[3] < bb[1] || ab[1] > bb[3]) return false;
  if (a.some((r) => r.some((p) => contains(p, b))) || b.some((r) => r.some((p) => contains(p, a)))) return true;
  for (const ar of a) for (let i = 0, j = ar.length - 1; i < ar.length; j = i++) {
    const aa = ar[j], az = ar[i];
    for (const br of b) for (let k = 0, l = br.length - 1; k < br.length; l = k++) {
      const ba = br[l], bz = br[k];
      if (turn(aa, az, ba) * turn(aa, az, bz) < 0 && turn(ba, bz, aa) * turn(ba, bz, az) < 0) return true;
    }
  }
  return false;
}
