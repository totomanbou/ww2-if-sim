import { mapProjection } from "./projection";
import type { MapData } from "../../src/sim/mapTypes";

/**
 * State lookup by lon/lat on the generated map (same projection as build-map.ts): the state whose
 * rings contain the point, or else the state with the nearest ring vertex (tiny islands, gaps).
 */
export function makeStateLookup(map: MapData): (lon: number, lat: number) => number {
  const projection = mapProjection(map.width, map.projection);
  const inRings = (x: number, y: number, rings: number[][]) => {
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  };
  return (lon, lat) => {
    const [x, y] = projection([lon, lat])!;
    for (const s of map.states) if (inRings(x, y, s.rings)) return s.id;
    let best = -1, bd = Infinity;
    for (const s of map.states) {
      for (const r of s.rings) {
        for (let k = 0; k < r.length; k += 2) {
          const d = (r[k] - x) ** 2 + (r[k + 1] - y) ** 2;
          if (d < bd) { bd = d; best = s.id; }
        }
      }
    }
    return best;
  };
}
