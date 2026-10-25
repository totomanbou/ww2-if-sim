import definitions from "../../data/important-cities.json";
import type { ImportantCity, MapState } from "../../src/sim/mapTypes";

function contains(rings: number[][], x: number, y: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const ax = ring[i], ay = ring[i + 1], bx = ring[j], by = ring[j + 1];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
  }
  return inside;
}

/** Bind historical city coordinates to the existing map; never change its states or borders. */
export function buildImportantCities(
  states: MapState[], project: (lon: number, lat: number) => number[],
): ImportantCity[] {
  return definitions.map((city) => {
    const [lon, lat] = city.lonlat;
    const [x, y] = project(lon, lat);
    const own = states.filter((s) => s.owner === city.owner);
    let state = own.find((s) => contains(s.rings, x, y));
    // Rasterised coastlines can omit a city point. Use a nearby state of the correct 1939 owner.
    const km = (s: MapState) => Math.hypot(
      (s.lonlat[0] - lon) * Math.cos(lat * Math.PI / 180), s.lonlat[1] - lat,
    ) * 111.32;
    if (!state) state = [...own].sort((a, b) => km(a) - km(b))[0];
    if (!state || km(state) > 180) throw new Error(`No nearby ${city.owner} state for ${city.id}`);
    return { id: city.id, name: city.name, home: city.home, state: state.id,
      lonlat: [lon, lat], position: [x, y] };
  });
}
