import { describe, expect, it } from "vitest";
import { computeFronts, resolveCombat } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { step } from "../engine";
import { createSimulation } from "../init";
import type { SimState } from "../types";
import { makeMap, makeScenario, setWar } from "./helpers";

type Zone = SimConfig["defenceZones"][number];

const MOSCOW: [number, number] = [37.62, 55.75];
// About 195 km north of Moscow (inside a 250 km zone) and about 305 km north (outside it).
const INSIDE: [number, number] = [37.62, 57.5];
const OUTSIDE: [number, number] = [37.62, 58.5];

const config = {
  encirclement: false,
  lossFactors: {},
  lowPriorityFronts: {},
  slowAdvanceLand: {},
  capitulateOnCapitalLoss: [],
  capitulateOnContinentLoss: [],
  regionPriority: {},
  enemyPriority: {},
  closedLand: [],
  strengthFactors: {},
  surprise: {},
  seasons: [],
  matchupStrength: {},
  transitSpeedKmPerWeek: 1e9,
  holdShare: 0,
  indirectFrontPriority: 1,
  overseasDistanceFactor: 1,
  frontComparisonMode: "allocated",
  advanceRate: 2,
  advanceMax: 2,
  advanceBreadthEdges: 1e9,
  lossRate: 0.1,
  startDate: "1941-07-15",
  stepDays: 7,
  defenceZones: [],
} satisfies Partial<SimConfig>;

const zone = (over: Partial<Zone> = {}): Zone => ({
  name: "test zone", defender: "SOV", center: MOSCOW, radiusKm: 250, capture: 0, ...over,
});

/**
 * GER (state 0) borders SOV states 1..n; `lonlat[i]` places state i (undefined: no coordinates, so outside every zone).
 * `owners` overrides the owner of states 1..n (default all SOV).
 */
function setup(opts: { lonlat: ([number, number] | undefined)[]; owners?: string[]; seed?: number; cfg?: Partial<SimConfig>; ger?: number; sov?: number }) {
  const n = opts.lonlat.length - 1;
  const owners = ["GER", ...(opts.owners ?? Array(n).fill("SOV"))];
  const sim = createSimulation(
    makeMap({ owners, land: owners.slice(1).map((_, i) => [0, i + 1] as [number, number]), lonlat: opts.lonlat }),
    makeScenario({ GER: { faction: "axis" }, SOV: { faction: "allies" } }),
    { seed: opts.seed ?? 1, config: { ...config, ...opts.cfg } },
  );
  sim.military[sim.tags.indexOf("GER")] = opts.ger ?? 40;
  sim.military[sim.tags.indexOf("SOV")] = opts.sov ?? 10;
  setWar(sim, "GER", "SOV");
  return sim;
}

const fight = (sim: SimState) => resolveCombat(sim, computeFronts(sim))[0];

describe("defenceZones", () => {
  it("is empty in the test config and has the Moscow line by default", () => {
    expect(DEFAULT_CONFIG.defenceZones).toHaveLength(1);
    const [z] = DEFAULT_CONFIG.defenceZones;
    expect(z.defender).toBe("SOV");
    expect(z.center[0]).toBeCloseTo(37.62, 1);
    expect(z.center[1]).toBeCloseTo(55.75, 1);
    expect(z.radiusKm).toBe(250);
    expect(z.capture).toEqual([["1942-12-31", 0.15], ["1943-03-31", 1]]);
  });

  describe("no effect", () => {
    // Several steps of a real run: same battles, owners and rng with no zones, a capture-1 zone and an unknown defender.
    const run = (zones: Zone[], seed: number) => {
      const sim = setup({ lonlat: [undefined, INSIDE, OUTSIDE, INSIDE, OUTSIDE, MOSCOW], seed, cfg: { defenceZones: zones, advanceMax: 3, advanceRate: 3 } });
      const battles: unknown[] = [];
      for (let i = 0; i < 6; i++) step(sim, (b) => battles.push(b));
      return { battles, owner: Array.from(sim.owner), rng: sim.rng.state };
    };

    it("defenceZones [] equals a zone with capture 1 and a zone of an unknown defender (same seed)", () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        const base = run([], seed);
        expect(base.battles.length).toBeGreaterThan(0);
        expect(run([zone({ capture: 1 })], seed)).toEqual(base);
        expect(run([zone({ capture: 0, defender: "XXX" })], seed)).toEqual(base);
      }
    });

    it("an unknown defender tag is ignored (capture 0 protects nothing)", () => {
      const sim = setup({ lonlat: [undefined, INSIDE, INSIDE], cfg: { defenceZones: [zone({ defender: "NOPE" })] } });
      expect(fight(sim).captures.length).toBe(2);
    });

    it("a zone with a radius that contains no state changes nothing", () => {
      const a = setup({ lonlat: [undefined, OUTSIDE, OUTSIDE], cfg: { defenceZones: [] } });
      const b = setup({ lonlat: [undefined, OUTSIDE, OUTSIDE], cfg: { defenceZones: [zone()] } });
      expect(fight(b)).toEqual(fight(a));
      expect(b.rng.state).toBe(a.rng.state);
    });
  });

  describe("radius", () => {
    it("capture 0 keeps the defender's state inside the radius from being taken, while one outside is taken", () => {
      for (let seed = 1; seed <= 20; seed++) {
        const sim = setup({ lonlat: [undefined, INSIDE, OUTSIDE], seed, cfg: { defenceZones: [zone()] } });
        const b = fight(sim);
        expect(b.captures).toEqual([2]);
        expect(b.capturedFrom.map((o) => sim.tags[o])).toEqual(["SOV"]);
      }
    });

    it("without the zone the inside state is taken too (the zone is what protects it)", () => {
      let taken = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const sim = setup({ lonlat: [undefined, INSIDE, OUTSIDE], seed });
        if (fight(sim).captures.includes(1)) taken++;
      }
      expect(taken).toBeGreaterThan(0);
    });

    it("when every target is inside the zone with capture 0, nothing is taken", () => {
      const sim = setup({ lonlat: [undefined, INSIDE, MOSCOW, INSIDE], cfg: { defenceZones: [zone()] } });
      const b = fight(sim);
      expect(b?.captures ?? []).toEqual([]);
    });

    it("uses the great-circle distance to the centre: the boundary lies near radiusKm", () => {
      // 1 degree of latitude is about 111.2 km: 2.2 degrees (245 km) is inside 250 km, 2.3 degrees (256 km) outside.
      const near: [number, number] = [MOSCOW[0], MOSCOW[1] + 2.2];
      const far: [number, number] = [MOSCOW[0], MOSCOW[1] + 2.3];
      const sim = setup({ lonlat: [undefined, near, far], cfg: { defenceZones: [zone()] } });
      expect(fight(sim).captures).toEqual([2]);
      // Longitude degrees shrink with latitude: 3.5 degrees of longitude at 55.75N is about 220 km (inside), 4.5 is 283 km (outside).
      const e1: [number, number] = [MOSCOW[0] + 3.5, MOSCOW[1]];
      const e2: [number, number] = [MOSCOW[0] + 4.5, MOSCOW[1]];
      const sim2 = setup({ lonlat: [undefined, e1, e2], cfg: { defenceZones: [zone()] } });
      expect(fight(sim2).captures).toEqual([2]);
    });

    it("a larger radius includes more states", () => {
      const sim = setup({ lonlat: [undefined, INSIDE, OUTSIDE], cfg: { defenceZones: [zone({ radiusKm: 400 })] } });
      const b = fight(sim);
      expect(b?.captures ?? []).toEqual([]);
    });

    it("states without coordinates are outside every zone", () => {
      const sim = setup({ lonlat: [undefined, undefined, undefined], cfg: { defenceZones: [zone()] } });
      expect(fight(sim).captures.length).toBe(2);
    });
  });

  describe("capture factor", () => {
    // Captures per run on 4 states with 2 targets inside the zone and 2 outside.
    const total = (zones: Zone[], seeds = 200) => {
      let n = 0, inside = 0;
      for (let seed = 1; seed <= seeds; seed++) {
        const sim = setup({ lonlat: [undefined, INSIDE, INSIDE, OUTSIDE, OUTSIDE], seed, cfg: { defenceZones: zones, advanceRate: 1, advanceMax: 1 } });
        const b = fight(sim);
        n += b.captures.length;
        inside += b.captures.filter((t) => t === 1 || t === 2).length;
      }
      return { n, inside };
    };

    it("capture 1 is identical to no zone", () => {
      for (let seed = 1; seed <= 20; seed++) {
        const a = setup({ lonlat: [undefined, INSIDE, OUTSIDE, INSIDE], seed });
        const b = setup({ lonlat: [undefined, INSIDE, OUTSIDE, INSIDE], seed, cfg: { defenceZones: [zone({ capture: 1 })] } });
        expect(fight(b)).toEqual(fight(a));
        expect(b.rng.state).toBe(a.rng.state);
      }
    });

    it("capture below 1 lowers the number of captures, and the ones inside the zone most", () => {
      const none = total([]);
      const half = total([zone({ capture: 0.5 })]);
      const low = total([zone({ capture: 0.1 })]);
      expect(half.n).toBeLessThan(none.n);
      expect(low.n).toBeLessThan(half.n);
      expect(low.inside).toBeLessThan(half.inside);
      expect(half.inside).toBeLessThan(none.inside);
      // The zone shifts the picks towards the outside states.
      expect(low.inside / low.n).toBeLessThan(none.inside / none.n);
    });

    it("scales the expected advance by the weighted average capture factor", () => {
      // All targets inside: the expected number of captures is advanceRate × (r-1) × factor, capped at advanceMax × factor.
      // r = 4 → min(2 × 0.5 cap, 2 × 3) with factor 0.5 → 1 capture every time.
      for (let seed = 1; seed <= 10; seed++) {
        const sim = setup({ lonlat: [undefined, INSIDE, INSIDE, INSIDE], seed, cfg: { defenceZones: [zone({ capture: 0.5 })] } });
        expect(fight(sim).captures).toHaveLength(1);
      }
    });
  });

  describe("defender", () => {
    it("only states owned by the defender are protected", () => {
      // Four Polish-owned states and one Soviet-owned state, all inside the zone, all at war with GER.
      const make = (seed: number, zones: Zone[]) => {
        const sim = createSimulation(
          makeMap({ owners: ["GER", "POL", "POL", "POL", "POL", "SOV"], land: [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5]], lonlat: [undefined, INSIDE, INSIDE, INSIDE, INSIDE, INSIDE] }),
          makeScenario({ GER: { faction: "axis" }, POL: { faction: "allies" }, SOV: { faction: "allies" } }),
          { seed, config: { ...config, defenceZones: zones, advanceRate: 4, advanceMax: 4 } },
        );
        sim.military[sim.tags.indexOf("GER")] = 40;
        sim.military[sim.tags.indexOf("POL")] = 5;
        sim.military[sim.tags.indexOf("SOV")] = 5;
        setWar(sim, "GER", "POL");
        setWar(sim, "GER", "SOV");
        return sim;
      };
      let sovWithout = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const caps = fight(make(seed, [zone()])).captures;
        // Polish states are never protected (captures happen); the Soviet state (5) never falls.
        expect(caps.length).toBeGreaterThan(0);
        expect(caps).not.toContain(5);
        if (fight(make(seed, [])).captures.includes(5)) sovWithout++;
      }
      expect(sovWithout).toBeGreaterThan(0); // without the zone the Soviet state is a normal target
    });

    it("a state taken by someone else is no longer protected for the old owner (follows current ownership)", () => {
      const sim = setup({ lonlat: [undefined, INSIDE, INSIDE], cfg: { defenceZones: [zone()] } });
      expect(fight(sim)?.captures ?? []).toEqual([]);
      // Hand both states to the attacker's enemy under another owner: the defender no longer owns them, so the zone is off.
      const pol = createSimulation(
        makeMap({ owners: ["GER", "POL", "POL"], land: [[0, 1], [0, 2]], lonlat: [undefined, INSIDE, INSIDE] }),
        makeScenario({ GER: { faction: "axis" }, POL: { faction: "allies" }, SOV: { faction: "allies" } }),
        { seed: 1, config: { ...config, defenceZones: [zone()] } },
      );
      pol.military[pol.tags.indexOf("GER")] = 40;
      pol.military[pol.tags.indexOf("POL")] = 10;
      setWar(pol, "GER", "POL");
      expect(fight(pol).captures).toHaveLength(2);
    });

    it("several zones apply together", () => {
      const far: [number, number] = [37.62, 62];
      const sim = setup({
        lonlat: [undefined, INSIDE, far, OUTSIDE],
        cfg: { defenceZones: [zone(), zone({ center: far, radiusKm: 50 })] },
      });
      expect(fight(sim).captures).toEqual([3]);
    });
  });

  describe("schedule", () => {
    const sched: [string, number][] = [["1942-12-31", 0], ["1943-03-31", 1]];
    const at = (date: string, capture: Zone["capture"] = sched) => {
      let taken = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const sim = setup({ lonlat: [undefined, INSIDE, INSIDE], seed, cfg: { startDate: date, defenceZones: [zone({ capture })] } });
        taken += fight(sim)?.captures.length ?? 0;
      }
      return taken;
    };

    it("protects fully before the first date and not at all after the last", () => {
      expect(at("1941-07-15")).toBe(0);
      expect(at("1942-12-31")).toBe(0);
      expect(at("1943-03-31")).toBeGreaterThan(0);
      expect(at("1944-01-01")).toBeGreaterThan(0);
      expect(at("1944-01-01")).toBe(at("1944-01-01", 1));
    });

    it("interpolates linearly between the dates", () => {
      const before = at("1943-01-15");
      const mid = at("1943-02-15");
      const late = at("1943-03-15");
      expect(before).toBeLessThanOrEqual(mid);
      expect(mid).toBeLessThanOrEqual(late);
      expect(late).toBeGreaterThan(before);
    });

    it("the schedule follows the simulation clock across steps", () => {
      const owned = (s: SimState) => Array.from(s.owner).filter((o) => s.tags[o] === "SOV").length;
      const run = (startDate: string) => {
        const sim = setup({ lonlat: [undefined, INSIDE, INSIDE], cfg: { startDate, defenceZones: [zone({ capture: sched })], advanceRate: 3, advanceMax: 3 } });
        for (let i = 0; i < 3; i++) step(sim);
        return owned(sim);
      };
      expect(run("1942-12-01")).toBe(2); // three weeks inside the protected period
      expect(run("1943-04-01")).toBeLessThan(2); // after the schedule has reached 1
    });

    it("the default Moscow line lowers captures near Moscow in 1941 and leaves 1944 alone", () => {
      const run = (date: string, zones: Zone[]) => {
        let n = 0;
        for (let seed = 1; seed <= 100; seed++) {
          const sim = setup({ lonlat: [undefined, INSIDE, INSIDE, INSIDE], seed, cfg: { startDate: date, defenceZones: zones } });
          n += fight(sim)?.captures.length ?? 0;
        }
        return n;
      };
      expect(run("1941-12-01", DEFAULT_CONFIG.defenceZones)).toBeLessThan(run("1941-12-01", []));
      expect(run("1944-01-01", DEFAULT_CONFIG.defenceZones)).toBe(run("1944-01-01", []));
    });
  });

  describe("pick weights", () => {
    it("affect which target is picked, not only how many (capture below 1 shifts picks towards unprotected states)", () => {
      let inside = 0, outside = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const sim = setup({ lonlat: [undefined, INSIDE, OUTSIDE], seed, cfg: { defenceZones: [zone({ capture: 0.2 })], advanceRate: 1, advanceMax: 1 } });
        for (const t of fight(sim)?.captures ?? []) { if (t === 1) inside++; else outside++; }
      }
      // Weights 0.2 : 1 give an expected share of about 1/6 inside.
      expect(outside).toBeGreaterThan(inside * 2);
      expect(inside).toBeGreaterThan(0);
    });

    it("documents current behaviour (suspected bug): capture 0 does not protect once the advance exceeds the open targets", () => {
      // pickTargets takes zero-weight candidates after the positive ones are used up (x = 0 >= w = 0 moves on to the
      // next index), so with an advance of 2 states and only one open target the capture-0 state is taken as well.
      let taken = 0;
      for (let seed = 1; seed <= 10; seed++) {
        const sim = setup({ lonlat: [undefined, INSIDE, OUTSIDE], seed, cfg: { defenceZones: [zone()], advanceRate: 10, advanceMax: 10 } });
        if (fight(sim).captures.includes(1)) taken++;
      }
      expect(taken).toBe(10);
    });
  });
});
