import { describe, expect, it } from "vitest";
import { step } from "../engine";
import { effectiveIndustry } from "../growth";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario } from "./helpers";

describe("military growth", () => {
  it("initializes military and adds masked weekly growth without combat", () => {
    const sim = createSimulation(
      makeMap({ owners: ["TAG"], land: [] }),
      makeScenario({ TAG: { industry: 52, stability: 0.5 } }),
      { mask: { TAG: { 1939: 2 } } },
    );
    const initial = 52 * 0.5 * sim.config.initialYears;
    expect(sim.military[0]).toBe(initial);
    step(sim);
    expect(sim.military[0]).toBeCloseTo(initial + 52 * 0.5 * 2 / 52);
  });

  it("adds yearly growth only in the week containing September 1, excluding tick zero", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A"], land: [] }),
      makeScenario({ A: { industry: 12, stability: 0.5 } }),
      { config: { growthMode: "yearly" }, mask: { A: { 1940: 3 } } },
    );
    const initial = sim.military[0];
    // Ticks 0..51 precede the anniversary week; tick 52 starts on 1940-08-30.
    for (let tick = 0; tick < 52; tick++) {
      expect(sim.tick).toBe(tick);
      step(sim);
      expect(sim.military[0]).toBe(initial);
    }
    step(sim);
    expect(sim.military[0]).toBe(initial + 12 * 0.5 * 3);
    step(sim);
    expect(sim.military[0]).toBe(initial + 12 * 0.5 * 3);
  });

  it("reduces the original owner's industry and credits the occupier per state weight", () => {
    const sim = createSimulation(
      makeMap({ owners: ["B", "A", "A", "A", "A"], land: [] }),
      makeScenario({ A: { industry: 80 }, B: { industry: 20 } }),
    );
    expect(sim.tags).toEqual(["A", "B"]);
    expect(Array.from(sim.weight)).toEqual([1, 0.25, 0.25, 0.25, 0.25]);
    expect(Array.from(effectiveIndustry(sim))).toEqual([80, 20]);
    sim.owner[1] = sim.tags.indexOf("B");
    expect(Array.from(effectiveIndustry(sim))).toEqual([60, 20 + 0.25 * 80 * 0.25]);
  });

  it("splits industry between homeland states and colonies", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "A", "A", "A", "A"],
        land: [],
        core: [true, true, false, false, false],
      }),
      makeScenario({ A: {} }),
    );
    expect(sim.weight[0]).toBe(0.75 / 2);
    expect(sim.weight[1]).toBe(0.75 / 2);
    for (const s of [2, 3, 4]) expect(sim.weight[s]).toBeCloseTo(0.25 / 3);
    expect(Array.from(sim.weight).reduce((sum, w) => sum + w, 0)).toBeCloseTo(1);
  });
});

describe("pre-war growth (config.preWarGrowth / initialYearsByCountry)", () => {
  const map = makeMap({ owners: ["USA", "JAP"], land: [] });
  const scenario = makeScenario(
    { USA: { industry: 52, stability: 1 }, JAP: { industry: 52, stability: 1 } },
    [{ date: "1939-09-15", a: ["JAP"], b: ["USA"] }],
  );

  it("starts USA with its own initial years and no production before it enters a war", () => {
    const sim = createSimulation(map, scenario, { mask: {}, config: { initialYearsByCountry: { USA: 0.2 }, preWarGrowth: { USA: 0 } } });
    const [jap, usa] = [sim.tags.indexOf("JAP"), sim.tags.indexOf("USA")];
    expect(sim.military[usa]).toBeCloseTo(52 * 0.2);
    expect(sim.military[jap]).toBeCloseTo(52 * sim.config.initialYears);
    step(sim); // 1939-09-01: not at war yet
    step(sim); // 1939-09-08
    expect(sim.military[usa]).toBeCloseTo(52 * 0.2);
    expect(sim.military[jap]).toBeCloseTo(52 * sim.config.initialYears + 2);
    step(sim); // 1939-09-15: war starts this tick, production with it
    expect(sim.entered[usa]).toBe(1);
    expect(sim.military[usa]).toBeCloseTo(52 * 0.2 + 1);
  });

  it("grows normally when the country is not listed", () => {
    const sim = createSimulation(map, scenario, { mask: {}, config: { initialYearsByCountry: {}, preWarGrowth: {} } });
    const usa = sim.tags.indexOf("USA");
    step(sim);
    expect(sim.military[usa]).toBeCloseTo(52 * sim.config.initialYears + 1);
  });
});
