import type { MapData } from "../../src/sim/mapTypes";
import { LAT_BOT, LAT_TOP } from "./grid";
import { PROJECTION_NAME, mapHeight, mapProjection } from "./projection";

/** Change display geometry only. In particular, never regenerate terrain or rebind city/state IDs. */
export function reprojectMap(source: MapData): MapData {
  const old = mapProjection(source.width, source.projection);
  const map = structuredClone(source);
  if (map.projection === PROJECTION_NAME) return map;
  const merc = mapProjection(map.width);
  const project = (lon: number, lat: number): [number, number] => {
    // Rounded legacy vertices can invert just beyond the original map extent.
    const ll: [number, number] = [Math.max(-180, Math.min(180, lon)), Math.max(LAT_BOT, Math.min(LAT_TOP, lat))];
    const xy = merc(ll);
    if (!xy || !xy.every(Number.isFinite)) throw new Error(`Cannot project ${ll}`);
    return [Math.round(xy[0]), Math.round(xy[1])];
  };
  for (const s of map.states) {
    s.rings = s.rings.map((r) => {
      const out: number[] = [];
      for (let i = 0; i < r.length; i += 2) {
        const ll = old.invert!([r[i], r[i + 1]]);
        if (!ll || !ll.every(Number.isFinite)) throw new Error(`Cannot invert vertex of state ${s.id}`);
        // d3 normalises inverse longitudes to ±180°. A rounded boundary vertex can invert past 180°
        // and wrap to the opposite edge; retain the side of the original projected vertex.
        const side = Math.sign(r[i] - old.translate()[0]);
        if (Math.abs(ll[0]) > 179 && Math.sign(ll[0]) !== side) ll[0] = side * 180;
        out.push(...project(ll[0], ll[1]));
      }
      return out;
    });
    s.center = project(...s.lonlat);
  }
  for (const c of map.importantCities ?? []) c.position = project(...c.lonlat);
  for (const z of map.seaZones) z.center = project(...z.lonlat);
  map.height = mapHeight(map.width);
  map.projection = PROJECTION_NAME;
  return map;
}
