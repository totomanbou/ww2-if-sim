import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSimulation } from "../init";
import type { Scenario, SimMap } from "../types";

const map: SimMap & { states: { owner: string; lonlat?: [number, number]; formerOwner?: string }[] } =
  JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8"));
const preset: Scenario = JSON.parse(readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"));

describe("Manchukuo as Japanese-occupied China", () => {
  const manchuria = map.states.filter((s) => s.owner === "JAP" && s.lonlat &&
    s.lonlat[0] >= 119 && s.lonlat[0] <= 135 && s.lonlat[1] >= 42.6 && s.lonlat[1] <= 53.5);

  it("marks the Japanese states of Manchuria as taken from China (formerOwner CHN)", () => {
    expect(manchuria.length).toBeGreaterThan(60);
    expect(manchuria.every((s) => s.formerOwner === "CHN")).toBe(true);
  });

  it("does not mark Korea, the home islands or Karafuto", () => {
    const outside = map.states.filter((s) => s.owner === "JAP" && s.lonlat &&
      ((s.lonlat[0] >= 124.5 && s.lonlat[0] <= 130 && s.lonlat[1] >= 33 && s.lonlat[1] <= 40) || // Korea
       (s.lonlat[0] >= 129.5 && s.lonlat[1] >= 30 && s.lonlat[1] <= 41.6) || // Kyushu to Honshu
       (s.lonlat[0] >= 139.5 && s.lonlat[1] >= 41.3 && s.lonlat[1] <= 45.6) || // Hokkaido
       (s.lonlat[0] >= 141.5 && s.lonlat[1] >= 45.9))); // Karafuto
    expect(outside.length).toBeGreaterThan(20);
    expect(outside.filter((s) => s.formerOwner === "CHN")).toEqual([]);
  });

  it("counts Manchuria as Chinese land for the slower advance (sim.landOf)", () => {
    const sim = createSimulation(map, preset);
    const chn = sim.tags.indexOf("CHN");
    const ids = map.states.flatMap((s, i) => (manchuria.includes(s) ? [i] : []));
    expect(ids.every((s) => sim.landOf[s] === chn)).toBe(true);
    expect(sim.config.slowAdvanceLand.CHN).toBeLessThan(1);
  });
});
