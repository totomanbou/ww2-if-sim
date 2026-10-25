/**
 * Country splits applied to the finished states (e.g. the Dutch East Indies as a country of its own, so that it
 * keeps fighting after the Netherlands capitulates). A state moves to the new tag if it belongs to `from`, its centre
 * lies in `bbox` [west, south, east, north] and, if given, inside `polygon` ([lon, lat] points, for a border a box
 * cannot follow, e.g. India and Burma), and, with `colonyOnly`, it is not part of the homeland (core). The moved
 * states become the new country's homeland (core).
 */
export interface CountrySplit { name: string; from: string; tag: string; bbox: number[]; polygon?: number[][]; colonyOnly?: boolean }

/** Even-odd point-in-polygon test. */
function inPolygon(lon: number, lat: number, poly: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

type State = { owner: string; lonlat: number[]; core: boolean };

export function splitCountries(states: State[], splits: CountrySplit[]): Map<string, number> {
  const moved = new Map<string, number>();
  for (const sp of splits) {
    const [w, s, e, n] = sp.bbox;
    for (const st of states) {
      if (st.owner !== sp.from || (sp.colonyOnly && st.core)) continue;
      const [lon, lat] = st.lonlat;
      if (lon < w || lon > e || lat < s || lat > n) continue;
      if (sp.polygon && !inPolygon(lon, lat, sp.polygon)) continue;
      st.owner = sp.tag;
      st.core = true;
      moved.set(sp.tag, (moved.get(sp.tag) ?? 0) + 1);
    }
  }
  return moved;
}

/** The state of `tag` whose centre is nearest to lon/lat (equirectangular), -1 if it has none. */
export function nearestState(states: (State & { id: number })[], tag: string, lon: number, lat: number): number {
  let best = -1, bestD = Infinity;
  const k = Math.cos((lat * Math.PI) / 180);
  for (const st of states) {
    if (st.owner !== tag) continue;
    const d = ((st.lonlat[0] - lon) * k) ** 2 + (st.lonlat[1] - lat) ** 2;
    if (d < bestD) { bestD = d; best = st.id; }
  }
  return best;
}
