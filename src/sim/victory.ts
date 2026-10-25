import type { VictoryCity } from "./mapTypes";
import { stepWeeks } from "./date";
import type { Faction, SimState, VictoryCondition } from "./types";

export const CITY_NAMES: Record<VictoryCity, string> = {
  London: "ロンドン", Moscow: "モスクワ", Honolulu: "ホノルル", Paris: "パリ",
  Rome: "ローマ", Berlin: "ベルリン", Tokyo: "東京",
};

export const ALL_CITIES = Object.keys(CITY_NAMES) as VictoryCity[];

/** Cities of conditions A and the allied condition (historically London/Moscow/Honolulu and Rome/Berlin/Tokyo). */
const TARGET_CITIES: VictoryCity[] = ["London", "Moscow", "Honolulu", "Rome", "Berlin", "Tokyo"];

/**
 * Side of a city: the current faction of its 1939 owner (factions can be changed per country). A city "falls"
 * when the opposite faction holds it; a city of a neutral country never counts as fallen.
 */
export function citySide(sim: SimState, city: VictoryCity): Faction {
  return sim.faction[sim.origOwner[sim.cities[city]]];
}

/**
 * Victory targets for the current factions. Axis A: the allied-side cities among London, Moscow, Honolulu,
 * Rome, Berlin, Tokyo; allies: the axis-side ones (plus Paris if France is on the axis side). Cities of neutral
 * countries are left out, and a condition without cities cannot be met. Axis B needs Moscow and Paris on the
 * allied side. With the historical factions: A = London, Moscow, Honolulu; allies = Rome, Berlin, Tokyo; B on.
 */
export function victoryTargets(sim: SimState): {
  axisA: VictoryCity[]; allies: VictoryCity[]; axisB: boolean; axisBCapitals: number[];
} {
  const side = (c: VictoryCity) => citySide(sim, c);
  return {
    axisA: TARGET_CITIES.filter((c) => side(c) === "allies"),
    allies: [...TARGET_CITIES, ...(side("Paris") === "axis" ? ["Paris" as const] : [])].filter((c) => side(c) === "axis"),
    axisB: side("Moscow") === "allies" && side("Paris") === "allies",
    // Countries whose capital condition B also needs (config.axisBCapitals, e.g. Chongqing): allied-side ones only.
    axisBCapitals: sim.config.axisBCapitals.map((t) => sim.tags.indexOf(t))
      .filter((c) => c >= 0 && sim.faction[c] === "allies" && sim.capital[c] >= 0),
  };
}

/** True if the Axis holds country c's capital (config.axisBCapitals). */
export function capitalHeldByAxis(sim: SimState, c: number): boolean {
  return sim.faction[sim.owner[sim.capital[c]]] === "axis";
}

/** Faction currently holding a city's state. */
export function cityHolder(sim: SimState, city: VictoryCity): Faction {
  return sim.faction[sim.owner[sim.cities[city]]];
}

export function isFallen(sim: SimState, city: VictoryCity): boolean {
  const side = citySide(sim, city), holder = cityHolder(sim, city);
  return side !== "neutral" && holder !== "neutral" && holder !== side;
}

/**
 * Half-week victory check. Accumulates elapsed weeks in condition B (reset to 0 when it is not
 * met) and returns the condition met this week, if any. Checked in the order A, allies, B.
 */
export function checkVictory(sim: SimState): VictoryCondition | null {
  const f = (c: VictoryCity) => isFallen(sim, c);
  const t = victoryTargets(sim);
  // Condition B: Moscow fallen and Paris held by the Axis (Honolulu was dropped from B at the user's request), and
  // the capitals in config.axisBCapitals (Chongqing) held by the Axis (user requirement).
  const bHolds = t.axisB && f("Moscow") && cityHolder(sim, "Paris") === "axis" &&
    t.axisBCapitals.every((c) => capitalHeldByAxis(sim, c));
  sim.axisBWeeks = bHolds ? sim.axisBWeeks + stepWeeks(sim.config) : 0;
  if (t.axisA.length && t.axisA.every(f)) return "axisA";
  if (t.allies.length && t.allies.every(f)) return "allies";
  if (sim.axisBWeeks >= sim.config.axisBWeeks) return "axisB";
  return null;
}
