import { describe, expect, it } from "vitest";
import { capitulationRecipient, lostShare } from "../capitulation";
import { allocateArmies, computeFronts, resolveCombat, setOwner } from "../combat";
import type { SimConfig } from "../config";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

const config = {
  // Fixed capitulation threshold (independent of stability) for these fixtures.
  capitulationStabilitySlope: 0,
  encirclement: false,
  lossFactors: {},
  regionPriority: {},
  lowPriorityFronts: {},
  capitulateOnCapitalLoss: [],
  capitulateOnContinentLoss: [],
  transitSpeedKmPerWeek: 1e9,
  holdShare: 0,
  frontComparisonMode: "allocated",
  growthMode: "yearly",
  advanceRate: 0,
  lossRate: 0,
  fleetBattleChance: 0,
} satisfies Partial<SimConfig>;

function splitOccupation() {
  const sim = createSimulation(
    makeMap({ owners: ["C", "C", "C", "C", "C", "X", "Y"], land: [] }),
    makeScenario({ C: {}, X: {}, Y: {} }),
    { config },
  );
  const [c, x, y] = ["C", "X", "Y"].map((tag) => sim.tags.indexOf(tag));
  setWar(sim, "C", "X");
  setWar(sim, "C", "Y");
  // Y holds three original C states, X holds one, and C retains one.
  for (const state of [0, 1, 2]) setOwner(sim, state, y);
  setOwner(sim, 3, x);
  sim.military[c] = 10;
  sim.military[x] = 100;
  sim.military[y] = 1000;
  return { sim, c, x, y, nC: sim.tags.length };
}

function multipleLines() {
  const sim = createSimulation(
    makeMap({
      owners: ["C", "X", "C", "Y", "D", "X", "C", "X"],
      // X faces C on lines 0 and 6, and D on line 4. Y faces C on line 2.
      land: [[0, 1], [2, 3], [4, 5], [6, 7]],
    }),
    makeScenario({
      C: { faction: "allies" },
      D: { faction: "allies" },
      X: { faction: "axis" },
      Y: { faction: "axis" },
    }),
    { config },
  );
  const [c, d, x, y] = ["C", "D", "X", "Y"].map((tag) => sim.tags.indexOf(tag));
  setWar(sim, "C", "X");
  setWar(sim, "C", "Y");
  setWar(sim, "D", "X");
  sim.military[c] = 90;
  sim.military[d] = 30;
  sim.military[x] = 300;
  sim.military[y] = 20;
  return { sim, c, d, x, y, nC: sim.tags.length };
}

describe("capitulationRecipient facing army priority", () => {
  it("prefers the larger facing army over more original states held and a larger total military", () => {
    const { sim, c, x, y, nC } = splitOccupation();
    sim.facing[c * nC + x] = 200;
    sim.facing[c * nC + y] = 20;
    // Reverse-direction entries must not affect C's recipient.
    sim.facing[x * nC + c] = 1;
    sim.facing[y * nC + c] = 5000;

    expect(capitulationRecipient(sim, c)).toBe(x);
  });

  it("breaks an equal positive facing tie by original states held before total military", () => {
    const { sim, c, x, y, nC } = splitOccupation();
    sim.facing[c * nC + x] = sim.facing[c * nC + y] = 50;
    sim.military[x] = 10000;

    expect(capitulationRecipient(sim, c)).toBe(y);
  });

  it("falls back to original states held when all facing armies are zero", () => {
    const { sim, c, x, y } = splitOccupation();
    sim.military[x] = 10000;

    expect(Array.from(sim.facing).every((army) => army === 0)).toBe(true);
    expect(capitulationRecipient(sim, c)).toBe(y);
  });

  it.each([0, 50])("breaks equal facing (%i) and states held by military, then lower index", (army) => {
    const { sim, c, x, y, nC } = splitOccupation();
    setOwner(sim, 2, x);
    sim.facing[c * nC + x] = sim.facing[c * nC + y] = army;

    expect(capitulationRecipient(sim, c)).toBe(y);

    sim.military[x] = sim.military[y];
    expect(x).toBeLessThan(y);
    expect(capitulationRecipient(sim, c)).toBe(x);
  });

  it.each(["capitulated", "not at war"] as const)("excludes a country that is %s despite all its advantages", (excluded) => {
    const { sim, c, x, y, nC } = splitOccupation();
    sim.facing[c * nC + x] = 20;
    sim.facing[c * nC + y] = 2000;
    if (excluded === "capitulated") sim.capitulated[y] = 1;
    else sim.atWar[c * nC + y] = sim.atWar[y * nC + c] = 0;

    expect(capitulationRecipient(sim, c)).toBe(x);

    sim.capitulated[x] = 1;
    expect(capitulationRecipient(sim, c)).toBe(-1);
  });
});

describe("resolveCombat facing armies", () => {
  it("sums allocated armies on C's front lines and excludes armies on other lines", () => {
    const { sim, c, d, x, y, nC } = multipleLines();
    const fronts = computeFronts(sim);
    const allocation = allocateArmies(sim, fronts);
    const cLines = [...fronts.lineFront].filter(([, holders]) => holders.has(c)).map(([line]) => line);
    expect(cLines).toEqual([0, 2, 6]);
    expect(fronts.lineFront.get(4)!.has(c)).toBe(false);
    expect(allocation.get(4)!.get(x)).toBeCloseTo(100);

    resolveCombat(sim, fronts);

    // No coordinates and immediate transit make deployed armies equal their allocations.
    for (const enemy of [x, y]) {
      const expected = cLines.reduce((sum, line) => sum + (allocation.get(line)?.get(enemy) ?? 0), 0);
      expect(sim.facing[c * nC + enemy]).toBeCloseTo(expected, 8);
    }
    expect(sim.facing[c * nC + x]).toBeCloseTo(200);
    expect(sim.facing[c * nC + y]).toBeCloseTo(20);
    expect(sim.facing[c * nC + x]).toBeGreaterThan(sim.facing[c * nC + y]);
    expect(sim.facing[c * nC + x]).toBeLessThan(sim.military[x]);
    expect(sim.facing[d * nC + x]).toBeCloseTo(100);
    expect(sim.facing[c * nC + d]).toBe(0);
    expect(sim.facing[c * nC + c]).toBe(0);
  });

  it("resets facing on every call when an enemy no longer shares C's front lines", () => {
    const { sim, c, d, x, y, nC } = multipleLines();
    resolveCombat(sim, computeFronts(sim));
    expect(sim.facing[c * nC + x]).toBeCloseTo(200);
    expect(sim.facing[c * nC + y]).toBeCloseTo(20);

    // X still fights D, and remains at war with C, but C now holds only the Y front.
    setOwner(sim, 0, d);
    setOwner(sim, 6, d);
    const fronts = computeFronts(sim);
    expect([...fronts.lineFront].filter(([, holders]) => holders.has(c)).map(([line]) => line)).toEqual([2]);
    expect(sim.atWar[c * nC + x]).toBe(1);

    resolveCombat(sim, fronts);

    expect(sim.facing[c * nC + x]).toBe(0);
    expect(sim.facing[c * nC + y]).toBeCloseTo(20);
    expect(sim.facing[d * nC + x]).toBeCloseTo(300);
    expect(sim.facing[c * nC + d]).toBe(0);
    expect(sim.facing[c * nC + c]).toBe(0);
  });
});

describe("capitulation recipient through step", () => {
  it("gives C's remaining homeland to the larger facing army and names X in the event", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["C", "C", "C", "C", "C", "C", "X", "Y", "N"],
        land: [[4, 6], [4, 7], [4, 5]],
        // Neutral N holds the victory cities so the fixture cannot end in victory.
        cities: { London: 8, Moscow: 8, Honolulu: 8, Paris: 8, Rome: 8, Berlin: 8, Tokyo: 8 },
      }),
      makeScenario({
        C: { faction: "axis" },
        N: {},
        X: { name: "Front commander X", faction: "allies" },
        Y: { name: "Occupier Y", faction: "allies" },
      }),
      { config },
    );
    const [c, x, y] = ["C", "X", "Y"].map((tag) => sim.tags.indexOf(tag));
    const nC = sim.tags.length;
    setWar(sim, "C", "X");
    setWar(sim, "C", "Y");
    for (const state of [0, 1, 2]) setOwner(sim, state, y);
    setOwner(sim, 3, x);
    sim.military[c] = 10;
    sim.military[x] = 200;
    sim.military[y] = 20;
    // Stale facing favours Y: step must run combat before choosing the recipient.
    sim.facing[c * nC + y] = 1000;
    expect(capitulationRecipient(sim, c)).toBe(y);
    expect(sim.owner[sim.capital[c]]).toBe(y);
    expect(lostShare(sim, c)).toBeCloseTo(4 / 6);
    expect(lostShare(sim, c)).toBeGreaterThan(sim.config.capitulationThreshold);
    expect([sim.owner[4], sim.owner[5]]).toEqual([c, c]);

    step(sim);

    expect(sim.facing[c * nC + x]).toBeCloseTo(200);
    expect(sim.facing[c * nC + y]).toBeCloseTo(20);
    expect(sim.capitulated[c]).toBe(1);
    // Advance is disabled: these remaining states can only transfer by capitulation.
    expect([sim.owner[4], sim.owner[5]]).toEqual([x, x]);
    expect([sim.owner[0], sim.owner[1], sim.owner[2], sim.owner[3]]).toEqual([y, y, y, x]);
    const events = sim.events.filter((event) => event.type === "capitulation");
    expect(events).toMatchObject([{ tick: 0, date: "1939-09-01", countries: ["C", "X"] }]);
    expect(events).toHaveLength(1);
    expect(events[0].text).toContain(sim.names[x]);
    expect(sim.result).toBeNull();
    expect(sim.tick).toBe(1);
  });
});

