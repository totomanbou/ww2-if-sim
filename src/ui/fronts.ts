import type { FrontArmy, SimState } from "../sim";
import { el } from "./dom";
import { flagEl } from "./flags";

/**
 * Regions for naming front lines: a state belongs to the first box that contains it ([lonMin, latMin, lonMax,
 * latMax]). A line is named after the region of most of its front states, plus a second region holding at least
 * REGION_SECOND_SHARE of them (a line that joined several theatres, e.g. "東部・北アフリカ戦線").
 */
const REGIONS: [string, [number, number, number, number]][] = [
  ["北欧", [4, 60.5, 45, 75]],
  ["グリーンランド", [-75, 58, -10, 85]],
  ["北アフリカ", [-17, 20, 35, 37.5]],
  ["イタリア", [6, 36, 16, 47.5]],
  ["バルカン", [16, 34, 30, 46.5]],
  ["西部", [-10, 42, 16, 60.5]],
  ["東部", [16, 40, 60, 60.5]],
  ["中東", [30, 12, 63, 42]],
  ["東アフリカ", [20, -15, 55, 20]],
  ["中央アフリカ", [-20, -35, 30, 20]],
  ["インド", [60, 5, 88, 40]],
  ["ビルマ", [88, 10, 101, 30]],
  ["中国", [97, 18, 135, 55]],
  ["東南アジア", [92, -11, 135, 18]],
  ["太平洋", [135, -50, 180, 60]],
  ["太平洋", [-180, -50, -100, 60]],
];
const REGION_SECOND_SHARE = 0.25;

export function regionOf(lon: number, lat: number): string | null {
  for (const [name, [w, s, e, n]] of REGIONS) if (lon >= w && lon <= e && lat >= s && lat <= n) return name;
  return null;
}

/** "東部戦線", "東部・北アフリカ戦線", or null if no front state lies in a known region. */
export function frontRegionName(sim: SimState, states: number[]): string | null {
  const count = new Map<string, number>();
  for (const s of states) {
    const r = regionOf(sim.stateLonLat[2 * s], sim.stateLonLat[2 * s + 1]);
    if (r) count.set(r, (count.get(r) ?? 0) + 1);
  }
  const ranked = [...count].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const names = [ranked[0][0]];
  if (ranked[1] && ranked[1][1] >= REGION_SECOND_SHARE * states.length) names.push(ranked[1][0]);
  return `${names.join("・")}戦線`;
}

/** Army figures as on the charts: integers from 10, one decimal below. */
function fmtArmy(v: number): string {
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
}

/** How many countries a side lists before "ほかNか国". */
const MAX_LISTED = 4;
/** Fronts shown (largest total army first). */
const MAX_FRONTS = 8;
/** Lines with less army in total are left out (stray contacts, isolated islands). */
const MIN_TOTAL = 0.5;

/**
 * Panel content: per front line, the land army of each country with its flag, axis above allies, and a bar of the
 * two sides' shares (user requirement: show how much land army is on which front, with flags).
 */
export function renderFronts(sim: SimState): HTMLElement[] {
  const fronts = visibleFronts(sim.frontArmies);
  if (!fronts.length) return [el("div", { class: "hint" }, "交戦中の戦線はありません")];
  return fronts.map((f) => frontEl(sim, f));
}

/** Keep the main entry of each landing approach visible alongside the largest ground fronts. */
export function visibleFronts(armies: FrontArmy[]): FrontArmy[] {
  const fronts = armies
    .map((f) => ({ f, total: f.armies.reduce((a, [, v]) => a + v, 0) }))
    .filter((x) => x.total >= MIN_TOTAL)
    .sort((a, b) => b.total - a.total);
  const main = new Map<string, FrontArmy>();
  for (const { f } of fronts) if (f.theatre && !main.has(f.theatre)) main.set(f.theatre, f);
  const selected = new Set([...main.values()].slice(0, MAX_FRONTS));
  for (const { f } of fronts) if (selected.size < MAX_FRONTS) selected.add(f);
  return fronts.filter(({ f }) => selected.has(f)).map(({ f }) => f);
}

/** The Soviet advance into Germany remains the eastern front, even west of the map's regional longitude cut. */
export function frontTitle(sim: SimState, f: FrontArmy): string | null {
  if (f.theatre) return `${f.theatre}上陸戦線`;
  const region = frontRegionName(sim, f.states);
  if (region?.includes("西部") && f.armies.some(([c, v]) => sim.tags[c] === "SOV" && v > 0)) return "東部戦線（ドイツ方面）";
  return region;
}

function frontEl(sim: SimState, f: FrontArmy): HTMLElement {
  const side = (fa: "axis" | "allies") => f.armies.filter(([c]) => sim.faction[c] === fa);
  const axis = side("axis"), allies = side("allies");
  const sum = (xs: [number, number][]) => xs.reduce((a, [, v]) => a + v, 0);
  const ax = sum(axis), al = sum(allies);
  const main = [axis[0], allies[0]].filter(Boolean).map(([c]) => sim.names[c]).join(" 対 ");
  const region = frontTitle(sim, f);
  const color = (c: number) => sim.scenario.countries[sim.tags[c]]?.color ?? "#999";
  const row = (fa: "axis" | "allies", xs: [number, number][], total: number) =>
    el("div", { class: `front-side ${fa}` },
      el("span", { class: "front-total" }, fmtArmy(total)),
      el("span", { class: "front-countries" },
        ...xs.slice(0, MAX_LISTED).map(([c, v]) =>
          el("span", { class: "front-country", title: `${sim.names[c]} ${fmtArmy(v)}` },
            flagEl(sim.tags[c], color(c), 12), el("span", {}, `${sim.names[c]} ${fmtArmy(v)}`))),
        ...(xs.length > MAX_LISTED ? [el("span", { class: "hint" }, `ほか${xs.length - MAX_LISTED}か国`)] : [])));
  const share = ax + al > 0 ? (100 * ax) / (ax + al) : 50;
  return el("div", { class: "front" },
    el("div", { class: "front-head" }, el("strong", {}, region ?? `${main}戦線`), region ? el("span", { class: "hint" }, main) : ""),
    el("div", { class: "front-bar", title: `枢軸 ${fmtArmy(ax)} / 連合 ${fmtArmy(al)}` }, el("i", { style: `width:${share.toFixed(1)}%` })),
    row("axis", axis, ax), row("allies", allies, al));
}
