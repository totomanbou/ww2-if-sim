import { describe, expect, it } from "vitest";
import { capitulate } from "../capitulation";
import { computeFronts, setOwner } from "../combat";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

function colonialPower() {
  const sim = createSimulation(
    makeMap({
      // B: homeland 0–2, colonies 3–4. B occupies C's states 6 (core) and 7 (non-core).
      owners: ["B", "B", "B", "B", "B", "X", "C", "C", "A", "C", "N"],
      core: [true, true, true, false, false, true, true, false, true, true, true],
      // Both colonies border an enemy; A can later liberate B's homeland state 1.
      land: [[0, 1], [1, 2], [1, 8], [3, 5], [4, 9]],
      capitals: { C: 9 },
      // Keep victory cities neutral so later step calls actually advance the simulation.
      cities: { London: 10, Moscow: 10, Honolulu: 10, Paris: 10, Rome: 10, Berlin: 10, Tokyo: 10 },
    }),
    makeScenario({
      A: { faction: "allies" }, B: { faction: "allies" },
      C: { faction: "axis" }, X: { faction: "axis" }, N: {},
    }),
    { config: {
      frontComparisonMode: "allocated", growthMode: "yearly", lossRate: 0,
      advanceRate: 100, advanceMax: 1, fleetBattleChance: 0, liberateToOriginalOwner: true,
    } },
  );
  const [a, b, c, x] = ["A", "B", "C", "X"].map((tag) => sim.tags.indexOf(tag));
  setOwner(sim, 6, b);
  setOwner(sim, 7, b);
  setWar(sim, "B", "X");
  setWar(sim, "B", "C");
  sim.military[a] = 100;
  sim.military[b] = 20;
  sim.military[c] = sim.military[x] = 1000;
  return { sim, a, b, c, x };
}

describe("colonies after capitulation", () => {
  it("transfers homeland and occupied foreign states while keeping its own original colonies", () => {
    const { sim, b, c, x } = colonialPower();
    expect(sim.origOwner[7]).toBe(c);
    expect(sim.core[7]).toBe(0);
    capitulate(sim, b, x);

    // C is X's ally (axis), so C's states that B had occupied are handed back to C instead of going to X.
    expect(Array.from(sim.owner).slice(0, 8)).toEqual([x, x, x, b, b, x, c, c]);
    expect(sim.capitulated[b]).toBe(1);
    expect(sim.military[b]).toBeCloseTo(0);
    const nC = sim.tags.length;
    for (let country = 0; country < nC; country++) {
      expect(sim.atWar[b * nC + country]).toBe(0);
      expect(sim.atWar[country * nC + b]).toBe(0);
    }
  });

  it("leaves enemy-adjacent colonies at peace through later weeks", () => {
    const { sim, b, x } = colonialPower();
    const before = computeFronts(sim);
    expect(before.line[3]).toBeGreaterThanOrEqual(0);
    expect(before.line[4]).toBeGreaterThanOrEqual(0);
    capitulate(sim, b, x);

    for (let week = 1; week <= 6; week++) {
      step(sim);
      expect(sim.tick).toBe(week);
      expect(sim.result).toBeNull();
      expect([sim.owner[3], sim.owner[4]]).toEqual([b, b]);
      expect(sim.capitulated[b]).toBe(1);
      expect(sim.military[b]).toBeCloseTo(0);
      const fronts = computeFronts(sim);
      expect(fronts.frontCount[b]).toBe(0);
      expect([fronts.line[3], fronts.line[4]]).toEqual([-1, -1]);
      for (let country = 0; country < sim.tags.length; country++) {
        expect(sim.atWar[b * sim.tags.length + country]).toBe(0);
        expect(sim.atWar[country * sim.tags.length + b]).toBe(0);
      }
    }
  });

  it("revives when an ally liberates a homeland state and retains its colonies", () => {
    const { sim, a, b, x } = colonialPower();
    capitulate(sim, b, x);
    expect([sim.owner[3], sim.owner[4]]).toEqual([b, b]);
    expect(sim.capitulated[b]).toBe(1);
    sim.military[x] = 10;
    setWar(sim, "A", "X");

    step(sim);
    expect(sim.tick).toBe(1);
    expect(sim.result).toBeNull();
    expect(sim.owner[1]).toBe(b);
    expect(sim.owner[sim.capital[b]]).toBe(x);
    expect([sim.owner[3], sim.owner[4]]).toEqual([b, b]);
    expect(sim.capitulated[b]).toBe(0);
    expect(sim.entered[b]).toBe(1);
    expect(sim.revivedAwaitingCapital[b]).toBe(1);
    expect(sim.military[b]).toBeCloseTo(0);
    expect(sim.atWar[b * sim.tags.length + x]).toBe(1);
    expect(sim.atWar[x * sim.tags.length + b]).toBe(1);
    expect(sim.events.filter((event) => event.type === "revival")).toMatchObject([
      { tick: 0, countries: ["B", "A"] },
    ]);
    expect(sim.owner[8]).toBe(a);
  });
});
