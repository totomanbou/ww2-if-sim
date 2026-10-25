import { describe, expect, it } from "vitest";
import { applyBattles, computeFronts, encircledStates, resolveCombat } from "../combat";
import type { SimConfig } from "../config";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { fleetPower } from "../navy";
import type { SimState } from "../types";
import { makeMap, makeScenario, setWar } from "./helpers";

// A's capital (0) supplies its mainland (1), but not its pocket (2).
// X's pocket target (3) connects to X's capital (5); mainland target (4) is separate.
const land: [number, number][] = [[0, 1], [1, 4], [2, 3], [3, 5]];

function pocket(
  map: Partial<Parameters<typeof makeMap>[0]> = {},
  config: Partial<SimConfig> = {},
) {
  const sim = createSimulation(
    makeMap({
      owners: ["A", "A", "A", "X", "X", "X", "B", "N"],
      land,
      capitals: { A: 0, X: 5, B: 6, N: 7 },
      ...map,
    }),
    makeScenario({
      A: { faction: "allies" }, B: { faction: "allies" },
      X: { faction: "axis" }, N: { faction: "neutral" },
    }),
    {
      seed: 17,
      config: {
        // Compare whole armies so allocation and transit cannot hide an allowed attack.
        frontComparisonMode: "nation",
        advanceRate: 100, advanceMax: 10, lossRate: 0,
        slowAdvanceLand: {}, lossFactors: {}, navalSuperiority: 0.7,
        ...config,
      },
    },
  );
  sim.military.fill(1);
  sim.military[sim.tags.indexOf("A")] = 1e6;
  setWar(sim, "A", "X");
  return sim;
}

function encircled(sim: SimState) {
  return encircledStates(sim, computeFronts(sim), fleetPower(sim));
}

function expectPocketCapture(sim: SimState, allowed: boolean) {
  const a = sim.tags.indexOf("A"), x = sim.tags.indexOf("X");
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles.flatMap((battle) => battle.captures).includes(3)).toBe(allowed);
  applyBattles(sim, battles);
  expect(sim.owner[3]).toBe(allowed ? a : x);
}

describe("encircled pockets", () => {
  it.each([
    { name: "default", config: {}, blocked: true },
    { name: "enabled", config: { encirclement: true }, blocked: true },
    { name: "disabled", config: { encirclement: false }, blocked: false },
  ])("blocks only pocket attacks with encirclement $name", ({ config, blocked }) => {
    const sim = pocket({}, config);
    const a = sim.tags.indexOf("A"), x = sim.tags.indexOf("X");
    expect(sim.config.encirclement).toBe(blocked);
    expect([...encircled(sim)]).toEqual([0, 0, 1, 0, 1, 0, 0, 0]);
    expectPocketCapture(sim, !blocked);
    // The same country attacks from its free mainland during the very same week.
    expect(sim.owner[4]).toBe(a);
    if (blocked) {
      for (let week = 1; week < 4; week++) expectPocketCapture(sim, false);
      expect(sim.owner[2]).toBe(a);
      expect(sim.owner[3]).toBe(x);
    }
  });

  it("still defends and can be captured by the enemy", () => {
    const sim = pocket();
    const a = sim.tags.indexOf("A"), x = sim.tags.indexOf("X");
    sim.military[a] = 1;
    sim.military[x] = 1e6;
    expect(encircled(sim)[2]).toBe(1);
    const battles = resolveCombat(sim, computeFronts(sim));
    const attack = battles.find((battle) => battle.captures.includes(2));
    expect(attack).toMatchObject({ attackers: [x], defenders: [a], defStrength: 1 });
    applyBattles(sim, battles);
    expect(sim.owner[2]).toBe(x);
  });

  it("allows attacks when the component contains A's capital", () => {
    const sim = pocket({ capitals: { A: 2, X: 5, B: 6, N: 7 } });
    expect(encircled(sim)[2]).toBe(0);
    expectPocketCapture(sim, true);
  });

  it("allows attacks with a neutral land neighbour that is not at war", () => {
    const sim = pocket({ land: [...land, [2, 7]] });
    expect(encircled(sim)[2]).toBe(0);
    expectPocketCapture(sim, true);
  });

  it("counts a neutral-faction neighbour as an enemy once it is at war", () => {
    const sim = pocket({ land: [...land, [2, 7]] });
    setWar(sim, "A", "N");
    expect(encircled(sim)[2]).toBe(1);
    expectPocketCapture(sim, false);
  });

  it("does not encircle an isolated component with no outside land neighbour", () => {
    const sim = pocket({ land: land.filter(([a, b]) => a !== 2 && b !== 2) });
    expect(encircled(sim)[2]).toBe(0);
  });

  it("uses an ally's capital in the same land component", () => {
    const sim = pocket({ land: [...land, [2, 6]] });
    const fronts = computeFronts(sim);
    expect(fronts.sideComp[2]).toBe(fronts.sideComp[6]);
    expect(fronts.sideComp[2]).not.toBe(fronts.sideComp[0]);
    expect(encircled(sim)[2]).toBe(0);
    expectPocketCapture(sim, true);
  });

  it("follows a land bridge through an ally to A's capital", () => {
    const sim = pocket({ land: [...land, [2, 6], [6, 0]] });
    const fronts = computeFronts(sim);
    expect(fronts.sideComp[2]).toBe(fronts.sideComp[0]);
    expect(encircled(sim)[2]).toBe(0);
    expectPocketCapture(sim, true);
  });

  it("keeps a capital-less component encircled even when it includes an ally", () => {
    const sim = pocket({
      owners: ["A", "A", "A", "X", "X", "X", "B", "N", "B"],
      land: [...land, [2, 6]], capitals: { A: 0, X: 5, B: 8, N: 7 },
    });
    setWar(sim, "B", "X");
    expect(computeFronts(sim).sideComp[2]).toBe(computeFronts(sim).sideComp[6]);
    expect(encircled(sim)[2]).toBe(1);
    expect(encircled(sim)[6]).toBe(1);
    expectPocketCapture(sim, false);
  });

  it("does not join land components through an unsupplied sea route to an ally", () => {
    const sim = pocket({ sea: [[2, 6]] });
    const fronts = computeFronts(sim);
    expect(fronts.sideComp[2]).not.toBe(fronts.sideComp[6]);
    expect(encircled(sim)[2]).toBe(1);
    expectPocketCapture(sim, false);
  });

  it("retains adjacency from A's free states next to the same target", () => {
    const sim = pocket({ land: [...land, [1, 3]] });
    expect(encircled(sim)[2]).toBe(1);
    expectPocketCapture(sim, true);
  });

  it.each([true, false])("recounts each ally's adjacency with encirclement = %s", (encirclement) => {
    // A's enormous army would win the captor comparison if its pocket adjacency survived.
    const sim = pocket({ land: [...land, [6, 3]] }, { encirclement });
    const a = sim.tags.indexOf("A"), b = sim.tags.indexOf("B"), x = sim.tags.indexOf("X");
    sim.military[b] = 100;
    setWar(sim, "B", "X");
    const fronts = computeFronts(sim);
    expect(fronts.targets.get(a * sim.tags.length + x)!.land.get(3)).toBe(1);
    expect(fronts.targets.get(b * sim.tags.length + x)!.land.get(3)).toBe(1);
    expect(encircled(sim)[2]).toBe(1);
    expect(encircled(sim)[6]).toBe(0);
    const battles = resolveCombat(sim, fronts);
    const attack = battles.find((battle) => battle.captures.includes(3))!;
    expect(attack).toBeDefined();
    const captor = encirclement ? b : a;
    expect(attack.captors[attack.captures.indexOf(3)]).toBe(captor);
    applyBattles(sim, battles);
    expect(sim.owner[3]).toBe(captor);
  });
});

describe("sea supply of pockets", () => {
  it.each<{
    name: string;
    fleets: [string, number, number][];
    supplied: boolean;
  }>([
    { name: "own fleet above the threshold", fleets: [["A", 0, 15], ["X", 0, 20]], supplied: true },
    // Separate fleets must be added by fleetPower; equality is enough for supply.
    { name: "own fleets exactly at the threshold", fleets: [["A", 0, 7], ["A", 0, 7], ["X", 0, 20]], supplied: true },
    { name: "enemy domination just below the threshold", fleets: [["A", 0, 13.9], ["X", 0, 20]], supplied: false },
    { name: "a positive fleet with no enemy navy", fleets: [["A", 0, 1]], supplied: true },
    { name: "no fleets on either side", fleets: [], supplied: false },
    { name: "only enemy fleets", fleets: [["X", 0, 20]], supplied: false },
    { name: "a zero-strength own fleet", fleets: [["A", 0, 0]], supplied: false },
    { name: "own superiority in the wrong zone", fleets: [["A", 1, 100], ["X", 0, 20]], supplied: false },
    { name: "an ally's fleet even without that ally being at war", fleets: [["B", 0, 14], ["X", 0, 20]], supplied: true },
    { name: "an unrelated neutral fleet", fleets: [["N", 0, 100]], supplied: false },
  ])("uses $name", ({ fleets, supplied }) => {
    const sim = pocket({ sea: [[2, 0, 0]], zones: [{ neighbors: [1] }, { neighbors: [0] }] });
    sim.fleets = fleets.map(([tag, zone, strength]) => ({
      country: sim.tags.indexOf(tag), zone, strength, target: zone,
    }));
    expect(encircled(sim)[2]).toBe(supplied ? 0 : 1);
    expectPocketCapture(sim, supplied);
  });

  it("counts the owner's own fleet even when its faction is neutral", () => {
    const sim = pocket({ sea: [[2, 0]] });
    const a = sim.tags.indexOf("A");
    sim.faction[a] = "neutral";
    sim.fleets = [{ country: a, zone: 0, target: 0, strength: 1 }];
    expect(encircled(sim)[2]).toBe(0);
    expectPocketCapture(sim, true);
  });

  it("supplies the entire component through a route from another member state", () => {
    const sim = pocket({
      owners: ["A", "A", "A", "X", "X", "X", "B", "N", "A"],
      land: [...land, [2, 8]], sea: [[8, 0]],
    });
    sim.fleets = [{ country: sim.tags.indexOf("A"), zone: 0, target: 0, strength: 1 }];
    expect(encircled(sim)[2]).toBe(0);
    expect(encircled(sim)[8]).toBe(0);
    expectPocketCapture(sim, true);
  });

  it("rechecks this week's navy before allowing the pocket to attack", () => {
    const sim = pocket({ sea: [[2, 0]] });
    expectPocketCapture(sim, false);
    sim.fleets = [{ country: sim.tags.indexOf("A"), zone: 0, target: 0, strength: 1 }];
    expectPocketCapture(sim, true);
  });
});
