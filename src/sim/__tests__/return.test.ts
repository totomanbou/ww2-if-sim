import { describe, expect, it } from "vitest";
import { capitulate, checkCapitulations } from "../capitulation";
import { setOwner, type Revival } from "../combat";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

function occupiedAllies(liberateToOriginalOwner = true) {
  const sim = createSimulation(
    makeMap({
      // C: homeland 0-1, colony 2. P and R each have a capital and two occupied states.
      owners: ["C", "C", "C", "A", "P", "P", "P", "Q", "Q", "Q", "X", "X", "R", "R", "R"],
      core: [true, true, false, true, true, true, false, true, true, false, true, true, true, true, false],
      // No fronts: step() can only return states through capitulation, not combat.
      land: [],
      // Neutral Q retains the victory cities so step() does not end in victory.
      cities: { London: 7, Moscow: 7, Honolulu: 7, Paris: 7, Rome: 7, Berlin: 7, Tokyo: 7 },
    }),
    makeScenario({
      A: { name: "Recipient", faction: "allies" },
      C: { faction: "axis" },
      P: { name: "First ally", faction: "allies" },
      Q: { faction: "neutral" },
      R: { name: "Second ally", faction: "allies" },
      X: { faction: "axis" },
    }),
    { config: {
      capitulationStabilitySlope: 0,
      encirclement: false,
      capitulateOnCapitalLoss: [],
      capitulateOnContinentLoss: [],
      lossFactors: {},
      liberateToOriginalOwner,
      lossRate: 0,
      fleetBattleChance: 0,
    } },
  );
  const [a, c, p, q, r, x] = ["A", "C", "P", "Q", "R", "X"].map((tag) => sim.tags.indexOf(tag));
  for (const state of [5, 6, 8, 9, 11, 13, 14]) setOwner(sim, state, c);
  // Returned states do not include the allies' capitals.
  setOwner(sim, 4, x);
  setOwner(sim, 12, x);
  setWar(sim, "A", "C");
  setWar(sim, "A", "X");
  setWar(sim, "A", "Q");
  return { sim, a, c, p, q, r, x };
}

function readyForCapitulation() {
  const fixture = occupiedAllies();
  const { sim, a, c, p, r, x } = fixture;
  capitulate(sim, p, x);
  capitulate(sim, r, x);
  // Losing both homeland states exceeds the threshold; C still holds its colony and occupations.
  setOwner(sim, 0, a);
  setOwner(sim, 1, a);
  expect(sim.capitulated[c]).toBe(0);
  return fixture;
}

describe("returning allied original states on capitulation", () => {
  it("returns allies' core and non-core states, transfers neutral states and homeland, and keeps original colonies", () => {
    const { sim, a, c, p, q, r, x } = occupiedAllies();
    const revivals: Revival[] = [];

    capitulate(sim, c, a, revivals);

    expect(Array.from(sim.owner)).toEqual([a, a, c, a, x, p, p, q, a, a, x, a, x, r, r]);
    expect(sim.capitulated[c]).toBe(1);
    expect(revivals).toEqual([]);
    expect(sim.revivedAwaitingCapital[p]).toBe(0);
    expect(sim.revivedAwaitingCapital[r]).toBe(0);
  });

  it("revives each capitulated ally once even when several of its states are returned", () => {
    const { sim, a, c, p, q, r, x } = occupiedAllies();
    capitulate(sim, p, x);
    capitulate(sim, r, x);
    const revivals: Revival[] = [];

    capitulate(sim, c, a, revivals);

    expect([sim.owner[5], sim.owner[6], sim.owner[13], sim.owner[14]]).toEqual([p, p, r, r]);
    expect(revivals).toEqual([
      { country: p, by: a, state: 5 },
      { country: r, by: a, state: 13 },
    ]);
    const nC = sim.tags.length;
    for (const ally of [p, r]) {
      expect(sim.capitulated[ally]).toBe(0);
      expect(sim.revivedAwaitingCapital[ally]).toBe(1);
      expect(sim.entered[ally]).toBe(1);
      expect(sim.capitalHeld[ally]).toBe(0);
      expect(sim.owner[sim.capital[ally]]).toBe(x);
      expect(sim.military[ally]).toBe(0);
      for (let enemy = 0; enemy < nC; enemy++) {
        // C is now out of the war; X and neutral Q remain the recipient's enemies.
        const expected = enemy === x || enemy === q ? 1 : 0;
        expect(sim.atWar[ally * nC + enemy]).toBe(expected);
        expect(sim.atWar[enemy * nC + ally]).toBe(expected);
      }
    }
  });

  it("gives all transferable states to the recipient without revival when liberation is disabled", () => {
    const { sim, a, c, p, q, r, x } = occupiedAllies(false);
    capitulate(sim, p, x);
    capitulate(sim, r, x);
    const revivals: Revival[] = [];

    capitulate(sim, c, a, revivals);

    expect(Array.from(sim.owner)).toEqual([a, a, c, a, x, a, a, q, a, a, x, a, x, a, a]);
    expect(revivals).toEqual([]);
    for (const ally of [p, r]) {
      expect(sim.capitulated[ally]).toBe(1);
      expect(sim.revivedAwaitingCapital[ally]).toBe(0);
      expect(sim.entered[ally]).toBe(0);
    }
  });

  it("gives an occupied state of the capitulating country's ally to the recipient", () => {
    const { sim, a, c, x } = occupiedAllies();
    const revivals: Revival[] = [];
    expect(sim.origOwner[11]).toBe(x);
    expect(sim.faction[x]).toBe(sim.faction[c]);

    capitulate(sim, c, a, revivals);

    expect(sim.owner[11]).toBe(a);
    expect(sim.owner[10]).toBe(x);
    expect(revivals).toEqual([]);
  });

  it("does not treat two neutral countries as allies for returning states", () => {
    const { sim, a, c, p, x } = occupiedAllies();
    sim.faction[a] = "neutral";
    sim.faction[p] = "neutral";
    capitulate(sim, p, x);
    const revivals: Revival[] = [];

    capitulate(sim, c, a, revivals);

    expect([sim.owner[5], sim.owner[6], sim.owner[8], sim.owner[9]]).toEqual([a, a, a, a]);
    expect(sim.capitulated[p]).toBe(1);
    expect(revivals).toEqual([]);
  });

  it("logs one revival event per returned ally naming the ally and recipient through step()", () => {
    const { sim, a, c, p, r } = readyForCapitulation();
    expect([sim.owner[5], sim.owner[13]]).toEqual([c, c]);

    step(sim);

    expect(sim.tick).toBe(1);
    expect(sim.result).toBeNull();
    expect(sim.capitulated[c]).toBe(1);
    expect([sim.owner[5], sim.owner[6], sim.owner[13], sim.owner[14]]).toEqual([p, p, r, r]);
    const revivals = sim.events.filter((event) => event.type === "revival");
    expect(revivals).toMatchObject([
      { tick: 0, countries: ["P", "A"] },
      { tick: 0, countries: ["R", "A"] },
    ]);
    const capitulationIndex = sim.events.findIndex((event) => event.type === "capitulation");
    expect(capitulationIndex).toBeGreaterThanOrEqual(0);
    expect(sim.events[capitulationIndex].countries).toEqual(["C", "A"]);
    for (const [index, ally] of [p, r].entries()) {
      expect(revivals[index].text).toContain(sim.names[ally]);
      expect(revivals[index].text).toContain(sim.names[a]);
      expect(sim.events.indexOf(revivals[index])).toBeGreaterThan(capitulationIndex);
    }
  });

  it("passes the caller's revival array through checkCapitulations", () => {
    const { sim, a, c, p, r } = readyForCapitulation();
    const revivals: Revival[] = [];

    expect(checkCapitulations(sim, revivals)).toEqual([[c, a]]);

    expect(revivals).toEqual([
      { country: p, by: a, state: 5 },
      { country: r, by: a, state: 13 },
    ]);
    expect([sim.owner[5], sim.owner[6], sim.owner[13], sim.owner[14]]).toEqual([p, p, r, r]);
    expect([sim.capitulated[p], sim.capitulated[r]]).toEqual([0, 0]);
    expect([sim.revivedAwaitingCapital[p], sim.revivedAwaitingCapital[r]]).toEqual([1, 1]);
  });
});
