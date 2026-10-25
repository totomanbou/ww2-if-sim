import { H, W } from "./grid";

/**
 * Traces the pixel boundaries of every label into closed rings on the pixel-corner lattice.
 * Rings run clockwise on screen (interior on the right); at pinch points the walk turns right,
 * so diagonally touching pixels stay in separate rings. Every lattice vertex is kept: dropping
 * collinear ones would hide T-junctions on one side of a border and stop TopoJSON from seeing the
 * border as shared (simplification removes the redundant vertices later). The x edges of the grid
 * are treated as borders (no wrap), so a region crossing the antimeridian becomes two rings. Adjacent labels produce identical shared paths,
 * which lets TopoJSON detect shared arcs.
 * Returns, per label, a list of rings as [i, j] corner coordinates.
 */
export function traceRings(label: Int32Array, nLabels: number): number[][][][] {
  const CW = W + 1;
  // Pass 1: count boundary edges per label.
  const counts = new Int32Array(nLabels + 1);
  const forEachEdge = (cb: (s: number, from: number, to: number, dir: number) => void) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = label[y * W + x];
        if (s < 0) continue;
        if (y === 0 || label[(y - 1) * W + x] !== s) cb(s, y * CW + x, y * CW + x + 1, 0);
        if (x === W - 1 || label[y * W + x + 1] !== s) cb(s, y * CW + x + 1, (y + 1) * CW + x + 1, 1);
        if (y === H - 1 || label[(y + 1) * W + x] !== s) cb(s, (y + 1) * CW + x + 1, (y + 1) * CW + x, 2);
        if (x === 0 || label[y * W + x - 1] !== s) cb(s, (y + 1) * CW + x, y * CW + x, 3);
      }
    }
  };
  forEachEdge((s) => counts[s + 1]++);
  const offs = new Int32Array(nLabels + 1);
  for (let s = 0; s < nLabels; s++) offs[s + 1] = offs[s] + counts[s + 1];
  const total = offs[nLabels];
  const eFrom = new Int32Array(total), eTo = new Int32Array(total), eDir = new Uint8Array(total);
  const fill = offs.slice();
  forEachEdge((s, from, to, dir) => {
    const k = fill[s]++;
    eFrom[k] = from;
    eTo[k] = to;
    eDir[k] = dir;
  });

  const out: number[][][][] = [];
  const used = new Uint8Array(total);
  for (let s = 0; s < nLabels; s++) {
    const a = offs[s], b = offs[s + 1];
    // Outgoing edges per start vertex (at most two at a pinch).
    const out1 = new Map<number, number>();
    const out2 = new Map<number, number>();
    for (let k = a; k < b; k++) {
      if (out1.has(eFrom[k])) out2.set(eFrom[k], k);
      else out1.set(eFrom[k], k);
    }
    const take = (v: number, dir: number): number => {
      const k1 = out1.get(v), k2 = out2.get(v);
      const c1 = k1 !== undefined && !used[k1] ? k1 : -1;
      const c2 = k2 !== undefined && !used[k2] ? k2 : -1;
      if (c1 < 0) return c2;
      if (c2 < 0) return c1;
      // Prefer right turn, then straight, then left.
      const rank = (k: number) => {
        const t = (eDir[k] - dir + 4) % 4;
        return t === 1 ? 0 : t === 0 ? 1 : 2;
      };
      return rank(c1) <= rank(c2) ? c1 : c2;
    };
    const rings: number[][][] = [];
    for (let k0 = a; k0 < b; k0++) {
      if (used[k0]) continue;
      const ring: number[][] = [];
      let k = k0;
      while (k >= 0 && !used[k]) {
        used[k] = 1;
        const v = eFrom[k];
        ring.push([v % CW, Math.floor(v / CW)]);
        k = take(eTo[k], eDir[k]);
      }
      ring.push(ring[0].slice());
      rings.push(ring);
    }
    out.push(rings);
  }
  return out;
}
