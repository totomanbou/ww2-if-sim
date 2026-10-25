import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nearestState, splitCountries, type CountrySplit } from "../../../scripts/map/split";
import { parseDate } from "../date";
import { weeklyTickTime as tickTime } from "./helpers";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import type { MapData } from "../mapTypes";
import type { Scenario } from "../types";

const map = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8")) as MapData;
const scenario = JSON.parse(
  readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"),
) as Scenario;
const fixes = JSON.parse(
  readFileSync(new URL("../../../data/border-fixes.json", import.meta.url), "utf8"),
) as { countrySplits: CountrySplit[]; capitals: Record<string, [number, number]> };

function state(owner: string, lon: number, lat: number, core = false) {
  return { owner, lonlat: [lon, lat], core };
}

const neiSplit: CountrySplit = {
  name: "Dutch East Indies", from: "HOL", tag: "NEI", bbox: [90, -13, 142, 8], colonyOnly: true,
};

function inIndies([lon, lat]: number[]): boolean {
  return lon >= 90 && lon <= 142 && lat >= -13 && lat <= 8;
}

describe("splitCountries", () => {
  it("includes every bbox edge and corner and leaves other owners and outside states untouched", () => {
    const inside = [
      [90, -13], [90, 8], [142, -13], [142, 8],
      [90, 0], [142, 0], [110, -13], [110, 8], [110, 0],
    ];
    const outside = [[89.99, 0], [142.01, 0], [110, -13.01], [110, 8.01]];
    const states = [
      ...inside.map(([lon, lat]) => state("HOL", lon, lat)),
      ...outside.map(([lon, lat]) => state("HOL", lon, lat)),
      state("UK", 110, 0),
      state("NEI", 110, 0),
    ];
    const before = structuredClone(states);

    expect(splitCountries(states, [neiSplit])).toEqual(new Map([["NEI", inside.length]]));
    expect(states).toEqual(before.map((st, i) =>
      i < inside.length ? { ...st, owner: "NEI", core: true } : st));
  });

  it.each([true, false, undefined])("respects colonyOnly = %s and makes moved states core", (colonyOnly) => {
    const states = [state("HOL", 110, 0, true), state("HOL", 111, 0)];
    const before = structuredClone(states);

    expect(splitCountries(states, [{ ...neiSplit, colonyOnly }])).toEqual(
      new Map([["NEI", colonyOnly ? 1 : 2]]),
    );
    expect(states).toEqual([
      colonyOnly ? before[0] : { ...before[0], owner: "NEI", core: true },
      { ...before[1], owner: "NEI", core: true },
    ]);
  });

  it("applies splits in order and accumulates counts for repeated destination tags", () => {
    const states = [state("A", 0, 0), state("A", 5, 5), state("X", 0, 0), state("B", 0, 0)];
    const splits: CountrySplit[] = [
      { name: "A to B", from: "A", tag: "B", bbox: [-1, -1, 1, 1] },
      { name: "X to B", from: "X", tag: "B", bbox: [-1, -1, 1, 1] },
      { name: "B to C", from: "B", tag: "C", bbox: [-1, -1, 1, 1] },
      { name: "remaining A to B", from: "A", tag: "B", bbox: [4, 4, 6, 6] },
    ];

    expect(splitCountries(states, splits)).toEqual(new Map([["B", 3], ["C", 3]]));
    expect(states).toEqual([
      state("C", 0, 0, true), state("B", 5, 5, true),
      state("C", 0, 0, true), state("C", 0, 0, true),
    ]);
  });

  it("skips a newly core state in a later colony-only split", () => {
    const states = [state("HOL", 110, 0)];
    const later = { ...neiSplit, from: "NEI", tag: "OTHER" };

    expect(splitCountries(states, [neiSplit, later])).toEqual(new Map([["NEI", 1]]));
    expect(states).toEqual([state("NEI", 110, 0, true)]);
  });

  it("returns no counts for empty inputs or splits with no eligible states", () => {
    const states = [state("HOL", 5, 52, true), state("UK", 110, 0)];
    const before = structuredClone(states);

    expect(splitCountries([], [neiSplit]).size).toBe(0);
    expect(splitCountries(states, []).size).toBe(0);
    expect(splitCountries(states, [neiSplit]).size).toBe(0);
    expect(states).toEqual(before);
  });
});

describe("nearestState", () => {
  it.each([
    { lat: 0, expected: 7 },
    { lat: 60, expected: 101 },
    { lat: -60, expected: 101 },
  ])("uses cosine-corrected distance at latitude $lat and returns a matching state's id", ({ lat, expected }) => {
    const states = [
      { ...state("UK", 0, lat), id: 3 },
      { ...state("NEI", 2, lat), id: 101 },
      { ...state("NEI", 0, lat + 1.2), id: 7 },
    ];
    const before = structuredClone(states);

    // At 60 degrees, 2 degrees of longitude is closer than 1.2 degrees of latitude.
    expect(nearestState(states, "NEI", 0, lat)).toBe(expected);
    expect(states).toEqual(before);
  });

  it("returns -1 when the requested tag has no states", () => {
    expect(nearestState([], "NEI", 106.8, -6.2)).toBe(-1);
    expect(nearestState([{ ...state("HOL", 106.8, -6.2), id: 42 }], "NEI", 106.8, -6.2)).toBe(-1);
  });
});

describe("Dutch East Indies map data", () => {
  it("assigns the East Indies to NEI as core states and keeps the Dutch homeland and western colonies in HOL", () => {
    expect(fixes.countrySplits.find((split) => split.tag === "NEI")).toMatchObject({
      from: "HOL", tag: "NEI", bbox: [90, -13, 142, 8], colonyOnly: true,
    });
    const indies = map.states.filter((st) => st.owner === "NEI");
    const dutch = map.states.filter((st) => st.owner === "HOL");
    const dutchTerritory = map.states.filter((st) => st.owner === "HOL" || st.owner === "NEI");

    expect(indies).toHaveLength(160);
    expect(indies.every((st) => inIndies(st.lonlat) && st.core)).toBe(true);
    expect(dutch).toEqual(dutchTerritory.filter((st) => !inIndies(st.lonlat)));
    expect(dutch.filter((st) => st.core).map((st) => st.id)).toEqual([537, 546, 580, 597, 623, 644, 669]);
    // Two Caribbean island states and Suriname must retain their original colonial status.
    expect(dutch.filter((st) => !st.core).map((st) => st.id)).toEqual([3143, 3329, 3467]);

    // Reconstruct the pre-split Dutch colonies and verify that the configured split reproduces the map.
    const beforeSplit = map.states.map((st) =>
      st.owner === "NEI" ? { ...st, owner: "HOL", core: false } : { ...st });
    expect(splitCountries(beforeSplit, fixes.countrySplits)).toEqual(new Map([["NEI", indies.length]]));
    expect(beforeSplit).toEqual(map.states);
  });

  it("records accurate state counts and an NEI capital near Batavia", () => {
    for (const tag of ["HOL", "NEI"]) {
      expect(map.countries[tag].stateCount).toBe(map.states.filter((st) => st.owner === tag).length);
    }
    expect(fixes.capitals.NEI).toEqual([106.82, -6.18]);
    const capital = map.states.find((st) => st.id === map.countries.NEI.defaultCapital);
    expect(capital).toBeDefined();
    expect(capital!.owner).toBe("NEI");
    expect(Math.abs(capital!.lonlat[0] - 106.8)).toBeLessThan(1);
    expect(Math.abs(capital!.lonlat[1] + 6.2)).toBeLessThan(1);
    expect(map.countries.NEI.defaultCapital).toBe(nearestState(map.states, "NEI", ...fixes.capitals.NEI));
  });

  it("moves nothing when the configured country splits are reapplied", () => {
    const states = structuredClone(map.states);

    expect(splitCountries(states, fixes.countrySplits)).toEqual(new Map());
    expect(states).toEqual(map.states);
  });
});

describe("Dutch East Indies historical scenario", () => {
  it("places NEI in the allies", () => {
    expect(scenario.countries.NEI.faction).toBe("allies");
  });

  it.each([
    { date: "1940-05-10", enemy: "GER" },
    { date: "1941-12-08", enemy: "JAP" },
  ])("includes NEI on the side opposing $enemy on $date", ({ date, enemy }) => {
    expect(scenario.wars.some((war) => war.date === date && (
      (war.a.includes(enemy) && war.b.includes("NEI")) ||
      (war.b.includes(enemy) && war.a.includes("NEI"))
    ))).toBe(true);
  });

  it("keeps NEI fighting independently through 1941-12-20", () => {
    const sim = createSimulation(map, scenario, { seed: scenario.seed });
    const [nei, hol, ger, jap] = ["NEI", "HOL", "GER", "JAP"].map((tag) => sim.tags.indexOf(tag));
    for (const index of [nei, hol, ger, jap]) expect(index).toBeGreaterThanOrEqual(0);
    const nC = sim.tags.length;
    const until = parseDate("1941-12-20");

    // Ticks are weekly; process only ticks on or before the deadline.
    while (!sim.result && tickTime(sim.startMs, sim.tick) <= until) {
      step(sim);
      if (sim.capitulated[hol]) {
        expect(sim.capitulated[nei]).toBe(0);
        expect(sim.atWar[nei * nC + ger]).toBe(1);
        expect(sim.atWar[ger * nC + nei]).toBe(1);
      }
    }

    expect(sim.result).toBeNull();
    expect(tickTime(sim.startMs, sim.tick - 1)).toBeLessThanOrEqual(until);
    expect(tickTime(sim.startMs, sim.tick)).toBeGreaterThan(until);
    expect(sim.capitulated[nei]).toBe(0);
    expect(sim.atWar[nei * nC + jap]).toBe(1);
    expect(sim.atWar[jap * nC + nei]).toBe(1);
  });
});
