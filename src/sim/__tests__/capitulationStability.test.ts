import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capitulationThreshold, checkCapitulations } from "../capitulation";
import { createSimulation } from "../init";
import { CAPITULATION_MASK } from "../mask";
import type { Scenario, SimMap } from "../types";
import { makeMap, makeScenario, setWar } from "./helpers";

const realMap: SimMap = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8"));
const realPreset: Scenario = JSON.parse(readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"));

/** One country (default tag "A", which has no mask) at the given stability, on a one-state map. */
function thresholdAt(stability: number, config = {}, tag = "A"): number {
  const sim = createSimulation(
    makeMap({ owners: [tag], land: [] }),
    makeScenario({ [tag]: { stability } }),
    { config },
  );
  return capitulationThreshold(sim, 0);
}

describe("capitulationThreshold: formula", () => {
  // defaults: 0.6 + 0.6 × (stability − 0.7), clamped to [0.3, 0.95]
  it.each([
    [0, 0.3], // 0.6 - 0.42 = 0.18 -> clamped up
    [0.4, 0.42],
    [0.7, 0.6],
    [0.95, 0.75],
    [1, 0.78],
  ])("stability %f gives %f with the defaults", (stability, expected) => {
    expect(thresholdAt(stability)).toBeCloseTo(expected, 10);
  });

  it("is clamped at the lower end", () => {
    expect(thresholdAt(0.1)).toBe(0.3);
    expect(thresholdAt(0.5, { capitulationThreshold: 0.1 })).toBe(0.3);
  });

  it("is clamped at the upper end", () => {
    expect(thresholdAt(1, { capitulationThreshold: 1.2 })).toBe(0.95);
    expect(thresholdAt(1, { capitulationStabilitySlope: 5 })).toBe(0.95);
  });

  it("is constant (the base) when the slope is 0", () => {
    for (const st of [0, 0.3, 0.7, 1]) expect(thresholdAt(st, { capitulationStabilitySlope: 0 })).toBeCloseTo(0.6, 10);
    expect(thresholdAt(0.2, { capitulationStabilitySlope: 0, capitulationThreshold: 0.5 })).toBeCloseTo(0.5, 10);
  });

  it("uses the configured reference stability", () => {
    expect(thresholdAt(0.5, { capitulationStabilityRef: 0.5 })).toBeCloseTo(0.6, 10);
  });

  it("is monotonic non-decreasing in stability", () => {
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const t = thresholdAt(i / 20);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});

describe("capitulationThreshold: hidden mask", () => {
  it("has the expected mask table", () => {
    expect(CAPITULATION_MASK).toEqual({ CHN: 2.2 });
  });

  it("multiplies a CHN country's threshold by 2.2 (stability 0.4: 0.42 x 2.2)", () => {
    expect(thresholdAt(0.4, {}, "CHN")).toBeCloseTo(0.42 * 2.2, 10);
  });

  it("clamps the masked CHN value", () => {
    expect(thresholdAt(0.7, {}, "CHN")).toBe(0.95); // 0.6 x 2.2 = 1.32
  });

  it("applies the mask before the clamp (a masked value below the lower bound is raised to it)", () => {
    // stability 0, ref 0.7: 0.18 x 2.2 = 0.396, above the default lower bound 0.3 but below a raised one
    expect(thresholdAt(0, {}, "CHN")).toBeCloseTo(0.396, 10);
    expect(thresholdAt(0, { capitulationThresholdRange: [0.5, 0.95] }, "CHN")).toBe(0.5);
  });

  it("does not apply the mask to other tags", () => {
    expect(thresholdAt(0.4, {}, "GER")).toBeCloseTo(0.42, 10);
    expect(thresholdAt(0.4, {}, "CHX")).toBeCloseTo(0.42, 10);
  });

  it("applies the mask to CHN only within a multi-country simulation", () => {
    const sim = createSimulation(
      makeMap({ owners: ["CHN", "JAP"], land: [] }),
      makeScenario({ CHN: { stability: 0.4 }, JAP: { stability: 0.4 } }),
    );
    expect(capitulationThreshold(sim, sim.tags.indexOf("CHN"))).toBeCloseTo(0.924, 10);
    expect(capitulationThreshold(sim, sim.tags.indexOf("JAP"))).toBeCloseTo(0.42, 10);
  });
});

describe("checkCapitulations uses the stability threshold", () => {
  /** A holds states 0..9 (capital 0), B has state 10; B occupies the first `lost` states of A. */
  function game(stability: number, lost: number, tag = "A") {
    const sim = createSimulation(
      makeMap({ owners: [...Array<string>(10).fill(tag), "B"], land: [] }),
      makeScenario({ [tag]: { stability }, B: {} }),
    );
    setWar(sim, tag, "B");
    const b = sim.tags.indexOf("B");
    for (let s = 0; s < lost; s++) sim.owner[s] = b;
    return sim;
  }

  it("takes the stability from the scenario", () => {
    expect(game(0.2, 0).stability[0]).toBeCloseTo(0.2, 10);
    expect(capitulationThreshold(game(0.2, 0), 0)).toBeCloseTo(0.3, 10);
    expect(capitulationThreshold(game(1, 0), 0)).toBeCloseTo(0.78, 10);
  });

  it("capitulates a low-stability country between the two thresholds (50 % lost, capital lost)", () => {
    const sim = game(0.2, 5); // threshold 0.3 < 0.5 < 0.78
    expect(checkCapitulations(sim)).toEqual([[0, 1]]);
    expect(sim.capitulated[0]).toBe(1);
  });

  it("does not capitulate a high-stability country with the same loss", () => {
    const sim = game(1, 5); // threshold 0.78 > 0.5
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.capitulated[0]).toBe(0);
  });

  it("capitulates the high-stability country once the loss reaches its threshold", () => {
    expect(checkCapitulations(game(1, 7))).toEqual([]); // 0.7 < 0.78
    expect(checkCapitulations(game(1, 8))).toEqual([[0, 1]]); // 0.8 >= 0.78
  });

  it("does not capitulate while the capital is held, however low the stability", () => {
    const sim = game(0.2, 0);
    for (let s = 5; s < 10; s++) sim.owner[s] = 1; // 50 % lost, capital (state 0) held
    expect(checkCapitulations(sim)).toEqual([]);
  });

  it("a CHN country holds out where an unmasked one of equal stability capitulates", () => {
    // stability 0.4: threshold 0.42 for others, 0.924 for CHN; 60 % lost
    expect(checkCapitulations(game(0.4, 6))).toEqual([[0, 1]]);
    expect(checkCapitulations(game(0.4, 6, "CHN"))).toEqual([]);
    const all = game(0.4, 10, "CHN");
    const chn = all.tags.indexOf("CHN");
    expect(checkCapitulations(all)).toEqual([[chn, all.tags.indexOf("B")]]);
  });
});

describe("capitulationThreshold on the historical preset", () => {
  const sim = createSimulation(realMap, realPreset);
  const th = (tag: string) => capitulationThreshold(sim, sim.tags.indexOf(tag));

  it("GER (stability 0.95) is 0.75", () => expect(th("GER")).toBeCloseTo(0.75, 10));
  it("SOV (stability 0.8) is 0.66", () => expect(th("SOV")).toBeCloseTo(0.66, 10));
  it("POL (stability 0.7) is 0.6", () => expect(th("POL")).toBeCloseTo(0.6, 10));
  it("CHN (stability 0.4) is about 0.924 with the mask", () => expect(th("CHN")).toBeCloseTo(0.924, 10));

  it("every country's threshold lies in the configured range", () => {
    const [lo, hi] = sim.config.capitulationThresholdRange;
    for (let c = 0; c < sim.tags.length; c++) {
      const t = capitulationThreshold(sim, c);
      expect(t).toBeGreaterThanOrEqual(lo);
      expect(t).toBeLessThanOrEqual(hi);
    }
  });
});
