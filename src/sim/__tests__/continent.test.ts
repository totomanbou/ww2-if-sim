import { describe, expect, it } from "vitest";
import {
  capitulate, capitulationRecipient, checkCapitulations, continentMass, lostContinent, lostShare,
} from "../capitulation";
import { revive, setOwner } from "../combat";
import type { SimConfig } from "../config";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

// Isolate continent loss from unrelated country-specific defaults.
const rules = {
  capitulateOnCapitalLoss: [],
  capitulateOnContinentLoss: [],
  lossFactors: {},
  lowPriorityFronts: {},
  slowAdvanceLand: {},
  capitulationThreshold: 0.6,
} satisfies Partial<SimConfig>;

function denmarkFixture(listed = true, hasContinentalStates = true) {
  const sim = createSimulation(
    makeMap({
      // 0–3: island homeland; 4–5: continental homeland; 6–7: colonies; 8–11: enemy mainland.
      owners: [
        "D", "D", "D", "D",
        hasContinentalStates ? "D" : "X", hasContinentalStates ? "D" : "X",
        "D", "D", "X", "X", "X", "X", "Y", "R",
      ],
      land: [[0, 1], [1, 2], [2, 3], [4, 5], [5, 8], [8, 9], [9, 10], [10, 11]],
      // A sea route must not join the capital's island to the continent's land mass.
      sea: [[0, 4]],
      core: [true, true, true, true, true, true, false, false],
      capitals: { D: 0, X: 11, Y: 12, R: 13 },
    }),
    makeScenario({
      D: { faction: "allies" }, R: { faction: "allies" },
      X: { faction: "axis" }, Y: { faction: "axis" },
    }),
    { seed: 42, config: { ...rules, capitulateOnContinentLoss: listed ? ["D"] : [] } },
  );
  const [d, x, y, r] = ["D", "X", "Y", "R"].map((tag) => sim.tags.indexOf(tag));
  setWar(sim, "D", "X");
  setWar(sim, "D", "Y");
  return { sim, d, x, y, r };
}

describe("continental land mass", () => {
  it.each([
    { name: "largest land mass", land: [[1, 2], [2, 3], [4, 5]], expected: 1 },
    { name: "smallest mass id when sizes tie", land: [[0, 2], [2, 4], [1, 3], [3, 5]], expected: 0 },
  ])("selects the $name", ({ land, expected }) => {
    const sim = createSimulation(
      makeMap({
        owners: Array<string>(6).fill("D"),
        land: land as [number, number][],
        sea: [[0, 1]],
      }),
      makeScenario({ D: { faction: "allies" } }),
      { config: { ...rules, capitulateOnContinentLoss: ["D"] } },
    );
    expect(continentMass(sim)).toBe(expected);
  });
});

describe("capitulation on continent loss", () => {
  it("waits for the last continental state, then capitulates despite holding its island capital", () => {
    const { sim, d, x } = denmarkFixture();
    expect(continentMass(sim)).toBe(4);
    expect(sim.landMass[sim.capital[d]]).toBe(0);
    expect(lostContinent(sim, d)).toBe(false);
    setOwner(sim, 4, x);
    expect(sim.owner[5]).toBe(d);
    expect(lostContinent(sim, d)).toBe(false);
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.capitulated[d]).toBe(0);

    setOwner(sim, 5, x);
    expect(lostContinent(sim, d)).toBe(true);
    expect(sim.owner[sim.capital[d]]).toBe(d);
    expect(lostShare(sim, d)).toBeCloseTo(0.25);
    expect(lostShare(sim, d)).toBeLessThan(sim.config.capitulationThreshold);
    expect(checkCapitulations(sim)).toEqual([[d, x]]);
    expect(sim.capitulated[d]).toBe(1);
  });

  it("does not capitulate an unlisted country in the same situation", () => {
    const { sim, d, x } = denmarkFixture(false);
    setOwner(sim, 4, x);
    setOwner(sim, 5, x);
    expect(lostContinent(sim, d)).toBe(true);
    expect(sim.owner[sim.capital[d]]).toBe(d);
    expect(lostShare(sim, d)).toBeLessThan(sim.config.capitulationThreshold);
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.capitulated[d]).toBe(0);
  });

  it("does not treat having no original continental states as losing the continent", () => {
    const { sim, d, x } = denmarkFixture(true, false);
    expect(continentMass(sim)).toBe(4);
    expect(Array.from(sim.origOwner).some((owner, s) => owner === d && sim.landMass[s] === 4)).toBe(false);
    expect(lostContinent(sim, d)).toBe(false);
    // Losing other original territory cannot turn an island-only country into a continental one.
    for (const s of [1, 2, 3, 6, 7]) setOwner(sim, s, x);
    expect(lostContinent(sim, d)).toBe(false);
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.capitulated[d]).toBe(0);
  });

  it("protects a listed revived country while it awaits its capital", () => {
    const { sim, d, x, r } = denmarkFixture();
    capitulate(sim, d, x);
    revive(sim, d, r);
    setOwner(sim, 1, d);
    setWar(sim, "D", "X");
    expect(sim.capitulated[d]).toBe(0);
    expect(sim.revivedAwaitingCapital[d]).toBe(1);
    expect(sim.owner[sim.capital[d]]).toBe(x);
    expect(lostContinent(sim, d)).toBe(true);
    expect(lostShare(sim, d)).toBeGreaterThan(sim.config.capitulationThreshold);
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.capitulated[d]).toBe(0);
    expect(sim.revivedAwaitingCapital[d]).toBe(1);
  });

  it("transfers the homeland to the recipient while retaining non-core original colonies", () => {
    const { sim, d, x, y } = denmarkFixture();
    setOwner(sim, 4, x);
    setOwner(sim, 5, x);
    // X's two occupied states outweigh Y's stronger army when choosing the recipient.
    sim.military[x] = 10;
    sim.military[y] = 1000;
    expect(capitulationRecipient(sim, d)).toBe(x);
    expect(sim.owner[sim.capital[d]]).toBe(d);
    expect(checkCapitulations(sim)).toEqual([[d, x]]);
    expect(Array.from(sim.owner).slice(0, 6)).toEqual(Array<number>(6).fill(x));
    for (const s of [6, 7]) {
      expect(sim.core[s]).toBe(0);
      expect(sim.origOwner[s]).toBe(d);
      expect(sim.owner[s]).toBe(d);
    }
    expect(sim.capitulated[d]).toBe(1);
    expect(sim.military[d]).toBe(0);
    for (const e of [x, y]) {
      expect(sim.atWar[d * sim.tags.length + e]).toBe(0);
      expect(sim.atWar[e * sim.tags.length + d]).toBe(0);
    }
  });
});
