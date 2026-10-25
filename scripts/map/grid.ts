// Equirectangular raster grid used by the map build. Pixel (x, y): x grows east from -180°, y grows south from LAT_TOP.
export const RES = 0.05;
export const LAT_TOP = 84;
export const LAT_BOT = -56;
export const W = Math.round(360 / RES);
export const H = Math.round((LAT_TOP - LAT_BOT) / RES);
export const N = W * H;
export const KM_PER_DEG = 111.32;
/** Vertical pixel size in km. */
export const PX_KM = RES * KM_PER_DEG;

export const lonOf = (x: number) => -180 + (x + 0.5) * RES;
export const latOf = (y: number) => LAT_TOP - (y + 0.5) * RES;
export const xOf = (lon: number) => ((Math.floor((lon + 180) / RES) % W) + W) % W;
export const yOf = (lat: number) => Math.min(H - 1, Math.max(0, Math.floor((LAT_TOP - lat) / RES)));

/** cos(lat) per row. */
export const rowCos = new Float64Array(H);
/** Pixel area in km² per row. */
export const rowArea = new Float64Array(H);
for (let y = 0; y < H; y++) {
  rowCos[y] = Math.cos((latOf(y) * Math.PI) / 180);
  rowArea[y] = PX_KM * PX_KM * rowCos[y];
}

/** Horizontal offset with wrap-around, in (-W/2, W/2]. */
export function wrapDx(dx: number): number {
  if (dx > W / 2) return dx - W;
  if (dx <= -W / 2) return dx + W;
  return dx;
}

export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** mulberry32: small seeded PRNG for reproducible builds. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Min-heap of (key, value) with lazy deletion, backed by growable typed arrays. */
export class Heap {
  keys = new Float64Array(1 << 16);
  vals = new Int32Array(1 << 16);
  size = 0;
  push(k: number, v: number) {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.size * 2);
      nk.set(this.keys);
      this.keys = nk;
      const nv = new Int32Array(this.size * 2);
      nv.set(this.vals);
      this.vals = nv;
    }
    let i = this.size++;
    const { keys, vals } = this;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= k) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  /** Pops the minimum; read topKey before calling. */
  topKey(): number {
    return this.keys[0];
  }
  pop(): number {
    const { keys, vals } = this;
    const out = vals[0];
    const n = --this.size;
    const k = keys[n];
    const v = vals[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && keys[c + 1] < keys[c]) c++;
      if (keys[c] >= k) break;
      keys[i] = keys[c];
      vals[i] = vals[c];
      i = c;
    }
    keys[i] = k;
    vals[i] = v;
    return out;
  }
}
