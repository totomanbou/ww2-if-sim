import type { SimState } from "./types";

/** Enemy occupation relative to a city's historical home, including cities occupied before September 1939. */
export function importantCityFallen(sim: SimState, index: number): boolean {
  const city = sim.importantCities[index];
  const home = sim.tags.indexOf(city.home);
  const owner = sim.owner[city.state];
  const a = sim.faction[home], b = sim.faction[owner];
  return (a === "allies" && b === "axis") || (a === "axis" && b === "allies");
}
