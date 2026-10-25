import { describe, expect, it } from "vitest";
import { checkCapitulations, lostShare } from "../capitulation";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

function splitOccupation() {
  const sim = createSimulation(
    makeMap({ owners: ["A", "A", "A", "A", "A", "B", "C"], land: [] }),
    makeScenario({ A: {}, B: {}, C: {} }),
  );
  setWar(sim, "A", "B");
  setWar(sim, "A", "C");
  // B holds three original A states; C holds one and has more military.
  sim.owner.set([1, 1, 1, 2, 0, 1, 2]);
  sim.military.set([50, 10, 1000]);
  return sim;
}

describe("capitulation", () => {
  it("clears military and all wars and transfers remaining states to the enemy holding most", () => {
    const sim = splitOccupation();
    expect(lostShare(sim, 0)).toBeCloseTo(0.8);
    expect(checkCapitulations(sim)).toEqual([[0, 1]]);
    expect(sim.capitulated[0]).toBe(1);
    expect(sim.military[0]).toBe(0);
    expect(Array.from(sim.owner)).toEqual([1, 1, 1, 2, 1, 1, 2]);
    for (let c = 0; c < sim.tags.length; c++) {
      expect(sim.atWar[c]).toBe(0);
      expect(sim.atWar[c * sim.tags.length]).toBe(0);
    }
  });

  it("does not capitulate with 90 percent lost while the capital is held", () => {
    const sim = createSimulation(
      makeMap({ owners: [...Array<string>(10).fill("A"), "B"], land: [] }),
      makeScenario({ A: {}, B: {} }),
    );
    setWar(sim, "A", "B");
    for (let s = 1; s < 10; s++) sim.owner[s] = 1;
    expect(lostShare(sim, 0)).toBeCloseTo(0.9);
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.capitulated[0]).toBe(0);
  });

  it.each([
    [5, false],
    [6, true],
  ])("with the capital lost and %i of 10 states lost, capitulation is %s", (lost, expected) => {
    const sim = createSimulation(
      makeMap({ owners: [...Array<string>(10).fill("A"), "B"], land: [] }),
      makeScenario({ A: {}, B: {} }),
    );
    setWar(sim, "A", "B");
    for (let s = 0; s < lost; s++) sim.owner[s] = 1;
    expect(lostShare(sim, 0)).toBeCloseTo(lost / 10);
    expect(checkCapitulations(sim)).toEqual(expected ? [[0, 1]] : []);
    expect(sim.capitulated[0]).toBe(Number(expected));
  });

  it("uses industry weight rather than state count for the lost share", () => {
    const sim = createSimulation(
      makeMap({
        owners: [...Array<string>(10).fill("A"), "B"],
        land: [],
        core: [true, true, ...Array<boolean>(8).fill(false), true],
        capitals: { A: 2 },
      }),
      makeScenario({ A: {}, B: {} }),
    );
    setWar(sim, "A", "B");
    // All eight colonies, including the chosen capital, account for only 25% of industry.
    for (let s = 2; s < 10; s++) sim.owner[s] = 1;
    expect(lostShare(sim, 0)).toBeCloseTo(0.25);
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.capitulated[0]).toBe(0);
  });

  it("logs a capitulation event through step", () => {
    const sim = splitOccupation();
    step(sim);
    expect(sim.events.filter((event) => event.type === "capitulation")).toMatchObject([
      { tick: 0, date: "1939-09-01", countries: ["A", "B"] },
    ]);
    expect(sim.capitulated[0]).toBe(1);
  });
});
