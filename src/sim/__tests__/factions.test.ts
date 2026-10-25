import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SimConfig } from "../config";
import { parseDate } from "../date";
import { step } from "../engine";
import { applyFactions, FACTION_WAR_NOTE, setFaction } from "../factions";
import { createSimulation } from "../init";
import type { Faction, Scenario, SimMap, SimState, WarDeclaration } from "../types";
import { checkVictory, citySide, isFallen, victoryTargets } from "../victory";
import { createWeeklySimulation, makeMap, makeScenario } from "./helpers";

const realMap: SimMap = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8"));
const realPreset: Scenario = JSON.parse(readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"));

/** Copy of `s` with the given factions changed. */
function withFactions(s: Scenario, changes: Record<string, Faction>): Scenario {
  const out = structuredClone(s);
  for (const [tag, faction] of Object.entries(changes)) out.countries[tag].faction = faction;
  return out;
}

const byDate = (wars: WarDeclaration[]) => [...wars].sort((p, q) => parseDate(p.date) - parseDate(q.date));
const gen = (date: string, a: string, b: string[]): WarDeclaration => ({ date, a: [a], b, note: FACTION_WAR_NOTE });

/** Small synthetic preset: A, B, C axis; X, Y allies; N, M neutral and out of every war. */
function syntheticPreset(): Scenario {
  return makeScenario(
    {
      A: { faction: "axis" }, B: { faction: "axis" }, C: { faction: "axis" },
      X: { faction: "allies" }, Y: { faction: "allies" },
      N: { faction: "neutral" }, M: { faction: "neutral" },
    },
    [
      { date: "1939-09-01", a: ["A", "B"], b: ["X"], note: "w1" },
      { date: "1940-05-01", a: ["A"], b: ["Y"], note: "w2" },
      { date: "1941-01-01", a: ["C"], b: ["Y"], note: "w3" },
    ],
  );
}

describe("applyFactions: unchanged factions", () => {
  it("returns the historical war list exactly when the real preset's factions are unchanged", () => {
    const out = applyFactions(realPreset, structuredClone(realPreset));
    expect(out.wars).toEqual(byDate(realPreset.wars));
    expect(out.wars.some((w) => w.note === FACTION_WAR_NOTE)).toBe(false);
  });

  it("returns the synthetic preset's wars unchanged", () => {
    const p = syntheticPreset();
    expect(applyFactions(p, p).wars).toEqual(p.wars);
  });

  it("sorts the result by date even when the input wars are out of order", () => {
    const p = syntheticPreset();
    const shuffled = structuredClone(p);
    shuffled.wars = [p.wars[2], p.wars[0], p.wars[1]];
    expect(applyFactions(p, shuffled).wars).toEqual(p.wars);
  });

  it("copies every other field (the note) of a kept declaration", () => {
    const out = applyFactions(syntheticPreset(), syntheticPreset());
    expect(out.wars.map((w) => w.note)).toEqual(["w1", "w2", "w3"]);
  });
});

describe("applyFactions: purity", () => {
  it("does not mutate the preset or the scenario and returns an independent clone", () => {
    const preset = syntheticPreset();
    const scenario = withFactions(preset, { X: "axis", N: "allies" });
    const presetBefore = structuredClone(preset), scenarioBefore = structuredClone(scenario);
    const out = applyFactions(preset, scenario);
    expect(preset).toEqual(presetBefore);
    expect(scenario).toEqual(scenarioBefore);
    expect(out).not.toBe(scenario);
    expect(out.wars).not.toBe(scenario.wars);
    expect(out.countries).not.toBe(scenario.countries);
    expect(out.countries).toEqual(scenario.countries);
    out.countries.A.industry = 999;
    out.wars[0].a.push("ZZZ");
    expect(scenario).toEqual(scenarioBefore);
  });
});

describe("applyFactions: splitting declarations per attacker", () => {
  it("drops same-faction pairs and pairs with a neutral, and keeps attackers with the same defenders grouped", () => {
    const preset = makeScenario(
      { A: { faction: "axis" }, B: { faction: "axis" }, C: { faction: "axis" }, X: { faction: "allies" }, Y: { faction: "allies" }, N: {} },
      [{ date: "1939-09-01", a: ["A", "B", "N", "C"], b: ["X", "Y", "C", "N"], note: "orig" }],
    );
    const out = applyFactions(preset, preset);
    // A, B and C each keep X and Y (C as a defender is a teammate, N is neutral); N attacks nobody. One grouped entry, note copied.
    expect(out.wars).toEqual([{ date: "1939-09-01", a: ["A", "B", "C"], b: ["X", "Y"], note: "orig" }]);
  });

  it("keeps attackers with different remaining defenders in separate entries", () => {
    const preset = makeScenario(
      { A: { faction: "axis" }, B: { faction: "allies" }, X: { faction: "allies" }, Y: { faction: "axis" } },
      [{ date: "1939-09-01", a: ["A", "B"], b: ["X", "Y"], note: "mix" }],
    );
    const out = applyFactions(preset, preset);
    expect(out.wars).toEqual([
      { date: "1939-09-01", a: ["A"], b: ["X"], note: "mix" },
      { date: "1939-09-01", a: ["B"], b: ["Y"], note: "mix" },
    ]);
  });

  it("treats a belligerent left without any kept pair as joining (a defender whose only pair was dropped)", () => {
    const preset = makeScenario(
      { A: { faction: "axis" }, C: { faction: "axis" }, X: { faction: "allies" } },
      [{ date: "1939-09-01", a: ["A"], b: ["X", "C"], note: "orig" }],
    );
    // C appeared in a war but its only pair (A-C, teammates) is dropped, so it joins and declares on X.
    expect(applyFactions(preset, preset).wars).toEqual([
      { date: "1939-09-01", a: ["A"], b: ["X"], note: "orig" },
      gen("1939-09-01", "C", ["X"]),
    ]);
  });

  it("drops a declaration with no opposing pair left", () => {
    const preset = makeScenario(
      { A: { faction: "axis" }, B: { faction: "axis" }, N: {} },
      [{ date: "1939-09-01", a: ["A"], b: ["B", "N"] }],
    );
    expect(applyFactions(preset, preset).wars).toEqual([]);
  });
});

describe("applyFactions: switching factions", () => {
  it("makes a country that switches to the other faction declare on the new enemies on the later entry date", () => {
    const preset = syntheticPreset();
    // X (allied, entry 1939-09-01) goes to the axis. A-X and B-X become same-faction pairs and are dropped; B is then
    // left without any kept pair and joins as well (entry 1939-09-01). Y (allies) first fights on 1940-05-01.
    const out = applyFactions(preset, withFactions(preset, { X: "axis" }));
    expect(out.wars).toEqual([
      { date: "1940-05-01", a: ["A"], b: ["Y"], note: "w2" },
      gen("1940-05-01", "B", ["Y"]),
      gen("1940-05-01", "X", ["Y"]),
      { date: "1941-01-01", a: ["C"], b: ["Y"], note: "w3" },
    ]);
  });

  it("uses the joining country's own entry date when it is later than the opposite country's", () => {
    const preset = syntheticPreset();
    // C (entry 1941-01-01) goes to the allies: C-Y becomes same-faction and is dropped. A and B entered earlier.
    const out = applyFactions(preset, withFactions(preset, { C: "allies" }));
    expect(out.wars).toEqual([
      ...preset.wars.slice(0, 2),
      gen("1941-01-01", "C", ["A", "B"]),
    ]);
  });

  it("uses the opposite country's entry date when it is later than the joining country's", () => {
    const preset = syntheticPreset();
    // A neutral that has no war enters on the first war date (1939-09-01) and fights C on C's own entry date.
    const out = applyFactions(preset, withFactions(preset, { N: "allies" }));
    const generated = out.wars.filter((w) => w.note === FACTION_WAR_NOTE);
    expect(generated).toContainEqual(gen("1941-01-01", "N", ["C"]));
  });

  it("drops the pairs of a country switched to neutral and generates no war for it", () => {
    const preset = syntheticPreset();
    const out = applyFactions(preset, withFactions(preset, { X: "neutral" }));
    // w1 (A,B vs X) is gone. B kept no pair, so it joins and meets Y on Y's first war date.
    expect(out.wars).toEqual([
      { date: "1940-05-01", a: ["A"], b: ["Y"], note: "w2" },
      gen("1940-05-01", "B", ["Y"]),
      { date: "1941-01-01", a: ["C"], b: ["Y"], note: "w3" },
    ]);
    expect(out.wars.some((w) => w.a.includes("X") || w.b.includes("X"))).toBe(false);
  });

  it("brings a neutral that never fought into the war on the first war date, grouping enemies per date", () => {
    const preset = syntheticPreset();
    const out = applyFactions(preset, withFactions(preset, { N: "allies" }));
    expect(out.wars).toEqual([
      preset.wars[0],
      gen("1939-09-01", "N", ["A", "B"]),
      preset.wars[1],
      preset.wars[2],
      gen("1941-01-01", "N", ["C"]),
    ]);
  });

  it("generates a single war for a single opposing pair", () => {
    const preset = makeScenario(
      { A: { faction: "axis" }, X: { faction: "allies" }, N: {} },
      [{ date: "1940-03-03", a: ["A"], b: ["X"], note: "only" }],
    );
    const out = applyFactions(preset, withFactions(preset, { N: "axis" }));
    expect(out.wars).toEqual([preset.wars[0], gen("1940-03-03", "N", ["X"])]);
  });

  it("generates each unordered pair once; the first joiner in key order declares", () => {
    const preset = syntheticPreset();
    // N (allies) and M (axis) both join. N is processed first, so it declares on M; M declares on X and Y only.
    const out = applyFactions(preset, withFactions(preset, { N: "allies", M: "axis" }));
    const generated = out.wars.filter((w) => w.note === FACTION_WAR_NOTE);
    expect(generated).toEqual([
      gen("1939-09-01", "N", ["A", "B", "M"]),
      gen("1941-01-01", "N", ["C"]),
      gen("1939-09-01", "M", ["X"]),
      gen("1940-05-01", "M", ["Y"]),
    ].sort((p, q) => parseDate(p.date) - parseDate(q.date)));
    const pairs = generated.flatMap((w) => w.a.flatMap((a) => w.b.map((b) => [a, b].sort().join("-"))));
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs).toContain("M-N");
  });

  it("returns wars sorted by date", () => {
    const preset = syntheticPreset();
    const out = applyFactions(preset, withFactions(preset, { N: "allies", X: "axis" }));
    const dates = out.wars.map((w) => parseDate(w.date));
    expect(dates).toEqual([...dates].sort((p, q) => p - q));
  });

  it("does not make a country with historical pairs join when all of them are kept", () => {
    const preset = syntheticPreset();
    // Only M switches; nobody else gets generated wars.
    const out = applyFactions(preset, withFactions(preset, { M: "axis" }));
    const generated = out.wars.filter((w) => w.note === FACTION_WAR_NOTE);
    expect(generated.every((w) => w.a[0] === "M")).toBe(true);
    expect(out.wars.filter((w) => w.note !== FACTION_WAR_NOTE)).toEqual(preset.wars);
  });

  it("does not regenerate a kept pair when both historical enemies switch factions", () => {
    const preset = makeScenario(
      { A: { faction: "axis" }, D: { faction: "allies" } },
      [{ date: "1939-09-01", a: ["A"], b: ["D"] }],
    );
    const out = applyFactions(preset, withFactions(preset, { A: "allies", D: "axis" }));
    expect(out.wars).toEqual([{ date: "1939-09-01", a: ["A"], b: ["D"] }]);
  });

  it("does not generate a second war for a pair already kept from history (preset-neutral country attacked historically)", () => {
    const preset = makeScenario(
      { A: { faction: "axis" }, D: { faction: "neutral" } },
      [{ date: "1939-09-01", a: ["A"], b: ["D"], note: "invasion" }],
    );
    const out = applyFactions(preset, withFactions(preset, { D: "allies" }));
    expect(out.wars).toEqual([
      { date: "1939-09-01", a: ["A"], b: ["D"], note: "invasion" },
    ]);
  });
});

describe("applyFactions: real historical preset", () => {
  it("ITA to the allies: generated ITA wars include GER on ITA's entry date and no war pairs ITA with the UK", () => {
    const out = applyFactions(realPreset, withFactions(realPreset, { ITA: "allies" }));
    const generated = out.wars.filter((w) => w.note === FACTION_WAR_NOTE);
    const itaVsGer = generated.find((w) => w.date === "1940-06-10" && w.a.length === 1 && w.a[0] === "ITA");
    expect(itaVsGer).toBeDefined();
    expect(itaVsGer!.b).toContain("GER");
    expect(itaVsGer!.b).toContain("JAP");
    expect(generated.every((w) => w.a.length === 1)).toBe(true);
    for (const w of out.wars) {
      const pairs = (x: string, y: string) => (w.a.includes(x) && w.b.includes(y)) || (w.a.includes(y) && w.b.includes(x));
      expect(pairs("ITA", "UK")).toBe(false);
    }
  });

  it("SPA to the axis: SPA declares on the allies, including POL on 1939-09-01", () => {
    const out = applyFactions(realPreset, withFactions(realPreset, { SPA: "axis" }));
    const spa = out.wars.filter((w) => w.a.includes("SPA"));
    expect(spa.length).toBeGreaterThan(1);
    expect(spa.every((w) => w.a.length === 1 && w.note === FACTION_WAR_NOTE)).toBe(true);
    const first = spa.find((w) => w.date === "1939-09-01");
    expect(first).toBeDefined();
    expect(first!.b).toContain("POL");
    // Only allied countries, each at most once, none declared before it entered the war.
    const defenders = spa.flatMap((w) => w.b);
    expect(new Set(defenders).size).toBe(defenders.length);
    for (const d of defenders) expect(realPreset.countries[d].faction).toBe("allies");
    const entry = (t: string) => Math.min(...realPreset.wars.filter((w) => w.a.includes(t) || w.b.includes(t)).map((w) => parseDate(w.date)));
    for (const w of spa) for (const d of w.b) expect(parseDate(w.date)).toBe(Math.max(entry(d), parseDate("1939-09-01")));
    // Everything historical is untouched.
    expect(out.wars.filter((w) => !w.a.includes("SPA"))).toEqual(byDate(realPreset.wars));
  });
});

describe("startWars: surprise", () => {
  const config: Partial<SimConfig> = {
    encirclement: false, lossFactors: {}, regionPriority: {}, lowPriorityFronts: {}, capitulateOnCapitalLoss: [],
    capitulateOnContinentLoss: [], holdShare: 0, successors: {}, lossRate: 0, advanceRate: 0, fleetBattleChance: 0,
    surprise: { D: { weeks: 4, factor: 0.25 } },
  };

  function fixture(wars: WarDeclaration[]): SimState {
    const map = makeMap({ owners: ["A", "D", "N"], land: [[0, 1]] });
    for (const city of Object.keys(map.cities) as (keyof typeof map.cities)[]) map.cities[city] = 2;
    return createWeeklySimulation(
      map,
      makeScenario({ A: { faction: "axis", industry: 100 }, D: { faction: "allies", industry: 100 }, N: {} }, wars),
      { config },
    );
  }

  function runUntilStarted(sim: SimState, nWars: number) {
    for (let i = 0; i < 20 && sim.nextWar < nWars; i++) step(sim);
    expect(sim.nextWar).toBe(nWars);
  }

  it("starts the surprise for a defender of a historical war", () => {
    const sim = fixture([{ date: "1939-09-15", a: ["A"], b: ["D"], note: "Barbarossa" }]);
    runUntilStarted(sim, 1);
    expect(sim.surpriseStart[sim.tags.indexOf("D")]).toBeGreaterThanOrEqual(0);
  });

  it("starts the surprise for a defender of a war without a note", () => {
    const sim = fixture([{ date: "1939-09-15", a: ["A"], b: ["D"] }]);
    runUntilStarted(sim, 1);
    expect(sim.surpriseStart[sim.tags.indexOf("D")]).toBeGreaterThanOrEqual(0);
  });

  it("does not start the surprise for a war generated by a faction change", () => {
    const sim = fixture([{ date: "1939-09-15", a: ["A"], b: ["D"], note: FACTION_WAR_NOTE }]);
    runUntilStarted(sim, 1);
    const [a, d] = [sim.tags.indexOf("A"), sim.tags.indexOf("D")];
    expect(sim.atWar[a * sim.tags.length + d]).toBe(1);
    expect(Array.from(sim.surpriseStart)).toEqual([-1, -1, -1]);
  });

  it("still starts the surprise at a later historical war after a generated one", () => {
    const sim = fixture([
      { date: "1939-09-15", a: ["A"], b: ["D"], note: FACTION_WAR_NOTE },
      { date: "1939-09-29", a: ["A"], b: ["D"], note: "historical" },
    ]);
    const d = sim.tags.indexOf("D");
    runUntilStarted(sim, 1);
    expect(sim.surpriseStart[d]).toBe(-1);
    const tickBefore = sim.tick;
    runUntilStarted(sim, 2);
    expect(sim.surpriseStart[d]).toBeGreaterThanOrEqual(tickBefore);
  });
});

describe("victory targets and factions", () => {
  const ORDER = ["London", "Moscow", "Honolulu", "Paris", "Rome", "Berlin", "Tokyo"] as const;
  const owners = ["ALY", "ALY", "ALY", "ALY", "AXI", "AXI", "AXI", "ALY2", "NEU"];
  const cityIds = Object.fromEntries(ORDER.map((c, i) => [c, i]));

  /** One state per city (in the order above) plus a spare allied and a neutral state. */
  function sim(ownerOf: Partial<Record<(typeof ORDER)[number], string>> = {}, factions: Record<string, Faction> = {}) {
    const o = [...owners];
    ORDER.forEach((c, i) => { if (ownerOf[c]) o[i] = ownerOf[c]!; });
    return createSimulation(
      makeMap({ owners: o, land: [], cities: cityIds }),
      makeScenario({
        ALY: { faction: "allies" }, ALY2: { faction: "allies" }, AXI: { faction: "axis" }, NEU: { faction: "neutral" },
        ...Object.fromEntries(Object.entries(factions).map(([t, f]) => [t, { faction: f }])),
      }),
    );
  }

  describe("real map and historical preset", () => {
    const real = createSimulation(realMap, realPreset);

    it("citySide follows the faction of the 1939 owner", () => {
      expect(citySide(real, "London")).toBe("allies");
      expect(citySide(real, "Moscow")).toBe("allies");
      expect(citySide(real, "Honolulu")).toBe("allies");
      expect(citySide(real, "Paris")).toBe("allies");
      expect(citySide(real, "Rome")).toBe("axis");
      expect(citySide(real, "Berlin")).toBe("axis");
      expect(citySide(real, "Tokyo")).toBe("axis");
    });

    it("has the historical targets: A = London, Moscow, Honolulu; allies = Rome, Berlin, Tokyo; B enabled", () => {
      expect(victoryTargets(real)).toEqual({
        axisA: ["London", "Moscow", "Honolulu"],
        allies: ["Rome", "Berlin", "Tokyo"],
        axisB: true,
        axisBCapitals: [real.tags.indexOf("CHN")],
      });
    });

    it("has no fallen city at the start and no victory", () => {
      for (const c of ORDER) expect(isFallen(real, c)).toBe(false);
      expect(checkVictory(real)).toBeNull();
    });

    it("reverses the targets when the factions of the capital owners are swapped", () => {
      const swapped = createSimulation(realMap, withFactions(realPreset, {
        UK: "axis", SOV: "axis", USA: "axis", GER: "allies", ITA: "allies", JAP: "allies",
      }));
      expect(victoryTargets(swapped)).toEqual({
        axisA: ["Rome", "Berlin", "Tokyo"],
        allies: ["London", "Moscow", "Honolulu"],
        axisB: false,
        axisBCapitals: swapped.faction[swapped.tags.indexOf("CHN")] === "allies" ? [swapped.tags.indexOf("CHN")] : [],
      });
    });
  });

  describe("synthetic factions", () => {
    it("historical-like layout: A and allies lists in order and B enabled", () => {
      expect(victoryTargets(sim())).toEqual({
        axisA: ["London", "Moscow", "Honolulu"], allies: ["Rome", "Berlin", "Tokyo"], axisB: true, axisBCapitals: [],
      });
    });

    it("an axis owner of Moscow puts Moscow in the allies list and disables axis B", () => {
      const s = sim({ Moscow: "AXI" });
      expect(victoryTargets(s)).toEqual({
        axisA: ["London", "Honolulu"], allies: ["Moscow", "Rome", "Berlin", "Tokyo"], axisB: false, axisBCapitals: [],
      });
    });

    it("an axis owner of Paris appends Paris to the allies list and disables axis B", () => {
      const s = sim({ Paris: "AXI" });
      expect(victoryTargets(s)).toEqual({
        axisA: ["London", "Moscow", "Honolulu"], allies: ["Rome", "Berlin", "Tokyo", "Paris"], axisB: false, axisBCapitals: [],
      });
    });

    it("an allied-side Paris is never a victory target of the axis A condition", () => {
      expect(victoryTargets(sim()).axisA).not.toContain("Paris");
    });

    it("a neutral owner puts a city in no list and it never counts as fallen", () => {
      const s = sim({ London: "NEU", Paris: "NEU" });
      const t = victoryTargets(s);
      expect(t.axisA).toEqual(["Moscow", "Honolulu"]);
      expect(t.allies).toEqual(["Rome", "Berlin", "Tokyo"]);
      expect(t.axisB).toBe(false);
      expect(citySide(s, "London")).toBe("neutral");
      s.owner[s.cities.London] = s.tags.indexOf("AXI");
      expect(isFallen(s, "London")).toBe(false);
      s.owner[s.cities.London] = s.tags.indexOf("ALY");
      expect(isFallen(s, "London")).toBe(false);
    });

    it("a city held by a neutral country is not fallen", () => {
      const s = sim();
      s.owner[s.cities.Berlin] = s.tags.indexOf("NEU");
      expect(isFallen(s, "Berlin")).toBe(false);
    });

    it("a city is fallen when the opposite faction holds it, not when its own side or a teammate does", () => {
      const s = sim();
      s.owner[s.cities.Berlin] = s.tags.indexOf("ALY");
      expect(isFallen(s, "Berlin")).toBe(true);
      s.owner[s.cities.Berlin] = s.tags.indexOf("AXI");
      expect(isFallen(s, "Berlin")).toBe(false);
      s.owner[s.cities.London] = s.tags.indexOf("ALY2");
      expect(isFallen(s, "London")).toBe(false);
    });

    it("changing a country's faction changes the side of its cities", () => {
      const s = sim({}, { AXI: "allies", ALY: "axis" });
      expect(victoryTargets(s)).toEqual({
        axisA: ["Rome", "Berlin", "Tokyo"], allies: ["London", "Moscow", "Honolulu", "Paris"], axisB: false, axisBCapitals: [],
      });
    });

    it("never awards axis A when it has no cities, even though every() of an empty list is true", () => {
      const s = sim({ London: "NEU", Moscow: "NEU", Honolulu: "NEU" });
      expect(victoryTargets(s).axisA).toEqual([]);
      for (let i = 0; i < 3; i++) expect(checkVictory(s)).toBeNull();
    });

    it("never awards the allied victory when it has no cities", () => {
      const s = sim({ Rome: "NEU", Berlin: "NEU", Tokyo: "NEU" });
      expect(victoryTargets(s).allies).toEqual([]);
      for (let i = 0; i < 3; i++) expect(checkVictory(s)).toBeNull();
    });

    it("still awards the other conditions when one list is empty", () => {
      const s = sim({ London: "NEU", Moscow: "NEU", Honolulu: "NEU" });
      for (const c of ["Rome", "Berlin", "Tokyo"] as const) s.owner[s.cities[c]] = s.tags.indexOf("ALY");
      expect(checkVictory(s)).toBe("allies");
      const t = sim({ Rome: "NEU", Berlin: "NEU", Tokyo: "NEU" });
      for (const c of ["London", "Moscow", "Honolulu"] as const) t.owner[t.cities[c]] = t.tags.indexOf("AXI");
      expect(checkVictory(t)).toBe("axisA");
    });

    it("awards axis A only for the allied-side cities of the changed factions", () => {
      // Moscow is axis-side: axis A needs London and Honolulu only.
      const s = sim({ Moscow: "AXI" });
      for (const c of ["London", "Honolulu"] as const) s.owner[s.cities[c]] = s.tags.indexOf("AXI");
      expect(checkVictory(s)).toBe("axisA");
    });

    it("does not count axis B (and does not accumulate) when Moscow is on the axis side", () => {
      const s = sim({ Moscow: "AXI" });
      s.owner[s.cities.Moscow] = s.tags.indexOf("ALY");
      s.owner[s.cities.Paris] = s.tags.indexOf("AXI");
      expect(isFallen(s, "Moscow")).toBe(true);
      for (let i = 0; i < s.config.axisBWeeks + 5; i++) expect(checkVictory(s)).toBeNull();
      expect(s.axisBWeeks).toBe(0);
    });

    it("does not count axis B when Paris is on the axis side", () => {
      const s = sim({ Paris: "AXI" });
      s.owner[s.cities.Moscow] = s.tags.indexOf("AXI");
      for (let i = 0; i < s.config.axisBWeeks + 5; i++) expect(checkVictory(s)).toBeNull();
      expect(s.axisBWeeks).toBe(0);
    });
  });
});

describe("setFaction: dependent countries follow their home country", () => {
  const faction = (s: Scenario, tag: string) => s.countries[tag].faction;

  it("moves the British dominions with the UK, the Dutch East Indies with the Netherlands, Free France with France", () => {
    const s: Scenario = structuredClone(realPreset);
    setFaction(s, "UK", "axis");
    for (const t of ["UK", "CAN", "AST", "NZL", "SAF"]) expect(faction(s, t)).toBe("axis");
    expect(faction(s, "NEI")).toBe("allies");
    setFaction(s, "HOL", "neutral");
    expect([faction(s, "HOL"), faction(s, "NEI")]).toEqual(["neutral", "neutral"]);
    setFaction(s, "FRA", "axis");
    expect(faction(s, "FFR")).toBe("axis");
    expect(faction(s, "USA")).toBe("allies");
  });

  it("changes a dependent country alone without touching its home country", () => {
    const s: Scenario = structuredClone(realPreset);
    setFaction(s, "CAN", "neutral");
    expect(faction(s, "CAN")).toBe("neutral");
    expect(faction(s, "UK")).toBe("allies");
    expect(faction(s, "AST")).toBe("allies");
  });

  it("follows chains and stops on cycles", () => {
    const s = makeScenario({ A: { faction: "allies" }, B: { faction: "allies" }, C: { faction: "allies" } });
    s.countries.B.overlord = "A";
    s.countries.C.overlord = "B";
    s.countries.A.overlord = "C";
    setFaction(s, "A", "axis");
    expect(["A", "B", "C"].map((t) => faction(s, t))).toEqual(["axis", "axis", "axis"]);
  });

  it("gives the dominions generated wars only through their own faction change (UK to the axis)", () => {
    const s: Scenario = structuredClone(realPreset);
    setFaction(s, "UK", "axis");
    const out = applyFactions(realPreset, s);
    for (const w of out.wars) {
      const pair = (x: string, y: string) => (w.a.includes(x) && w.b.includes(y)) || (w.a.includes(y) && w.b.includes(x));
      expect(pair("UK", "GER") || pair("CAN", "GER") || pair("UK", "CAN")).toBe(false);
    }
    expect(out.wars.some((w) => w.note === FACTION_WAR_NOTE && w.a[0] === "UK" && w.b.includes("FRA"))).toBe(true);
  });
});
