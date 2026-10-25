import { H, LAT_TOP, RES, W, xOf, yOf } from "./grid";

type Ring = number[][];
type Geometry = { type: string; coordinates: any };

/** Polygons (each a list of rings) of a GeoJSON Polygon/MultiPolygon. */
export function polygonsOf(geom: Geometry | null): Ring[][] {
  if (!geom) return [];
  if (geom.type === "Polygon") return [geom.coordinates];
  if (geom.type === "MultiPolygon") return geom.coordinates;
  return [];
}

/**
 * Scanline fill (even-odd) of one polygon; calls fill(index) for each pixel whose centre is inside.
 * A polygon too small to cover any pixel centre still marks the pixel under its first vertex,
 * so tiny islands are not lost. Returns the number of pixels marked.
 */
export function rasterizePolygon(rings: Ring[], fill: (i: number) => void): number {
  const rows = new Map<number, number[]>();
  for (const ring of rings) {
    for (let k = 0; k < ring.length - 1; k++) {
      const gx1 = (ring[k][0] + 180) / RES, gy1 = (LAT_TOP - ring[k][1]) / RES;
      const gx2 = (ring[k + 1][0] + 180) / RES, gy2 = (LAT_TOP - ring[k + 1][1]) / RES;
      if (gy1 === gy2) continue;
      const lo = Math.min(gy1, gy2), hi = Math.max(gy1, gy2);
      const y0 = Math.max(0, Math.ceil(lo - 0.5)), y1 = Math.min(H - 1, Math.ceil(hi - 0.5) - 1);
      for (let y = y0; y <= y1; y++) {
        const cy = y + 0.5;
        const x = gx1 + ((cy - gy1) / (gy2 - gy1)) * (gx2 - gx1);
        let r = rows.get(y);
        if (!r) rows.set(y, (r = []));
        r.push(x);
      }
    }
  }
  let count = 0;
  for (const [y, xs] of rows) {
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(W, Math.ceil(xs[k + 1] - 0.5));
      for (let x = xa; x < xb; x++) {
        fill(y * W + x);
        count++;
      }
    }
  }
  if (count === 0 && rings.length && rings[0].length) {
    const [lon, lat] = rings[0][0];
    if (lat < LAT_TOP && lat > LAT_TOP - H * RES) {
      fill(yOf(lat) * W + xOf(lon));
      count = 1;
    }
  }
  return count;
}

export function pointInBbox(lon: number, lat: number, b: number[]): boolean {
  return lon >= b[0] && lat >= b[1] && lon <= b[2] && lat <= b[3];
}

/** Even-odd point-in-polygon for a single [lon, lat] ring. */
export function pointInRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
