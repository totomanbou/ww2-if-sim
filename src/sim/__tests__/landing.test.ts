import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allocateArmies, computeFronts } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { activeLandingBans, blockedLandings, closedLandings } from "../landing";
import type { MapData } from "../mapTypes";
import { blockedLandings as blockedLandingsFromNavy, moveFleets } from "../navy";
import type { LandingRestriction, Scenario, SimState } from "../types";
import { createWeeklySimulation as createSimulation, makeMap, makeScenario, setWar } from "./helpers";

type Ban = SimConfig["landingBans"][number];

const ban = (over: Partial<Ban> = {}): Ban => ({
  name: "Test coast", faction: "allies", except: [], boxes: [[10, 30, 20, 50]], until: "1944-06-06", ...over,
});

const ids = (m: Uint8Array | null | undefined) => (m ? [...m].flatMap((v, s) => (v ? [s] : [])) : null);

describe("landing module: blockedLandings, activeLandingBans, closedLandings", () => {
  // States: 0 A (allies), 1 D (axis, core), 2 D (axis, not core), 3 X (axis), 4 E (allies).
  function fixture(restrictions: LandingRestriction[] = [], config: Partial<SimConfig> = {}) {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "D", "D", "X", "E"], land: [], core: [true, true, false, true, true],
        lonlat: [[1, 1], [15, 40], [12, 35], [15.5, 41], [25, 40]],
      }),
      { ...makeScenario({
        A: { faction: "allies" }, D: { faction: "axis" }, X: { faction: "axis" }, E: { faction: "allies" },
      }), landingRestrictions: restrictions },
      { config: { startDate: "1944-06-05", landingBans: [], ...config } },
    );
    return sim;
  }
  const restriction = (over: Partial<LandingRestriction> = {}): LandingRestriction => ({
    defender: "D", coreOnly: false, blockedWhileHeldBy: "axis", region: [3], ...over,
  });
  const tagOf = (sim: SimState, tag: string) => sim.tags.indexOf(tag);

  describe("blockedLandings", () => {
    it("is null without restrictions", () => {
      expect(blockedLandings(fixture())).toBeNull();
    });

    it("is still exported from navy.ts (same function)", () => {
      expect(blockedLandingsFromNavy).toBe(blockedLandings);
    });

    it("protects the defender's original states while the region is held by the faction", () => {
      const sim = fixture([restriction()]);
      expect(sim.restrictions).toHaveLength(1);
      expect(ids(blockedLandings(sim))).toEqual([1, 2]);
    });

    it("limits the protection to core states with coreOnly", () => {
      expect(ids(blockedLandings(fixture([restriction({ coreOnly: true })])))).toEqual([1]);
    });

    it("uses an explicit protect list instead of the defender's states", () => {
      expect(ids(blockedLandings(fixture([restriction({ protect: [0, 4] })])))).toEqual([0, 4]);
    });

    it("turns off once the region is no longer held by the faction, and back on when it is retaken", () => {
      const sim = fixture([restriction()]);
      sim.owner[3] = tagOf(sim, "A");
      expect(blockedLandings(sim)).toBeNull();
      sim.owner[3] = tagOf(sim, "E");
      expect(blockedLandings(sim)).toBeNull();
      sim.owner[3] = tagOf(sim, "X");
      expect(ids(blockedLandings(sim))).toEqual([1, 2]);
    });

    it("stays active while any region state is held by the faction", () => {
      const sim = fixture([restriction({ region: [0, 3] })]);
      expect(ids(blockedLandings(sim))).toEqual([1, 2]); // State 0 is allied, state 3 is axis.
      sim.owner[3] = tagOf(sim, "A");
      expect(blockedLandings(sim)).toBeNull();
    });

    it("compares the faction of the current owner, not the original one", () => {
      const sim = fixture([restriction({ blockedWhileHeldBy: "allies", region: [3] })]);
      expect(blockedLandings(sim)).toBeNull();
      sim.owner[3] = tagOf(sim, "A");
      expect(ids(blockedLandings(sim))).toEqual([1, 2]);
    });

    it("unions several active restrictions and skips inactive ones", () => {
      const sim = fixture([
        restriction({ coreOnly: true }),
        restriction({ protect: [4], region: [3] }),
        restriction({ protect: [0], region: [0] }), // Region held by allies, not axis.
      ]);
      expect(ids(blockedLandings(sim))).toEqual([1, 4]);
    });

    it("ignores restrictions for an unknown defender and out-of-range region states", () => {
      const sim = fixture([restriction({ defender: "ZZZ" }), restriction({ region: [-1, 99] })]);
      expect(sim.restrictions).toHaveLength(1);
      expect(sim.restrictions[0].region).toHaveLength(0);
      expect(blockedLandings(sim)).toBeNull();
    });

    it("reuses one cached (read-only) mask while the same restrictions are in force", () => {
      const sim = fixture([restriction()]);
      expect(blockedLandings(sim)).toBe(blockedLandings(sim));
      expect(ids(blockedLandings(sim))).toEqual([1, 2]);
    });
  });

  describe("activeLandingBans", () => {
    it("returns one null per country without bans", () => {
      const sim = fixture();
      expect(activeLandingBans(sim)).toEqual(Array(sim.tags.length).fill(null));
    });

    it("bans the faction's countries on states inside the box only", () => {
      const sim = fixture([], { landingBans: [ban()] });
      const bans = activeLandingBans(sim);
      for (const tag of ["A", "E"]) expect(ids(bans[tagOf(sim, tag)])).toEqual([1, 2, 3]);
      for (const tag of ["D", "X"]) expect(bans[tagOf(sim, tag)]).toBeNull();
    });

    it("exempts the countries listed in except", () => {
      const sim = fixture([], { landingBans: [ban({ except: ["E"] })] });
      const bans = activeLandingBans(sim);
      expect(ids(bans[tagOf(sim, "A")])).toEqual([1, 2, 3]);
      expect(bans[tagOf(sim, "E")]).toBeNull();
    });

    it("exempts states originally owned by exceptLand", () => {
      const sim = fixture([], { landingBans: [ban({ exceptLand: ["X"] })] });
      expect(ids(activeLandingBans(sim)[tagOf(sim, "A")])).toEqual([1, 2]);
    });

    it("applies the bans of the other faction to that faction's countries", () => {
      const sim = fixture([], { landingBans: [ban({ faction: "axis", boxes: [[0, 0, 2, 2]] })] });
      const bans = activeLandingBans(sim);
      for (const tag of ["D", "X"]) expect(ids(bans[tagOf(sim, tag)])).toEqual([0]);
      for (const tag of ["A", "E"]) expect(bans[tagOf(sim, tag)]).toBeNull();
    });

    it("unions overlapping bans for the same attacker, honouring the exception of each", () => {
      const sim = fixture([], { landingBans: [
        ban({ boxes: [[10, 30, 13, 36]], except: ["E"] }), // State 2 only.
        ban({ boxes: [[25, 40, 25, 40]], name: "Second" }), // State 4 only.
      ] });
      const bans = activeLandingBans(sim);
      expect(ids(bans[tagOf(sim, "A")])).toEqual([2, 4]);
      expect(ids(bans[tagOf(sim, "E")])).toEqual([4]);
    });

    it("expires on the until date as the simulation ticks (cached masks included)", () => {
      const sim = fixture([], { landingBans: [ban()] });
      const a = tagOf(sim, "A");
      expect(ids(activeLandingBans(sim)[a])).toEqual([1, 2, 3]);
      sim.tick = 1; // 1944-06-12.
      expect(activeLandingBans(sim)[a]).toBeNull();
    });

    it("is active until the day before until, and gone on the until date", () => {
      const before = fixture([], { landingBans: [ban()], startDate: "1944-06-05" });
      const onDate = fixture([], { landingBans: [ban()], startDate: "1944-06-06" });
      expect(ids(activeLandingBans(before)[tagOf(before, "A")])).toEqual([1, 2, 3]);
      expect(activeLandingBans(onDate)[tagOf(onDate, "A")]).toBeNull();
    });

    it("reuses cached (read-only) masks, shared by countries with the same bans", () => {
      const sim = fixture([], { landingBans: [ban()] });
      const a = tagOf(sim, "A"), e = tagOf(sim, "E");
      expect(activeLandingBans(sim)).toBe(activeLandingBans(sim));
      expect(activeLandingBans(sim)[a]).toBe(activeLandingBans(sim)[e]);
      expect(ids(activeLandingBans(sim)[a])).toEqual([1, 2, 3]);
    });

    it("leaves a country with no states in the box with an empty (not null) mask", () => {
      const sim = fixture([], { landingBans: [ban({ boxes: [[100, 60, 110, 70]] })] });
      const mask = activeLandingBans(sim)[tagOf(sim, "A")];
      expect(mask).not.toBeNull();
      expect(ids(mask)).toEqual([]);
    });
  });

  describe("closedLandings", () => {
    it("equals the active bans when no restriction applies", () => {
      const sim = fixture([], { landingBans: [ban()] });
      expect(closedLandings(sim)).toEqual(activeLandingBans(sim));
      const inactive = fixture([restriction({ region: [0] })], { landingBans: [ban()] });
      expect(closedLandings(inactive)).toEqual(activeLandingBans(inactive));
    });

    it("is all null without bans and restrictions", () => {
      const sim = fixture();
      expect(closedLandings(sim)).toEqual(Array(sim.tags.length).fill(null));
    });

    it("gives every country the restriction's protected states when only a restriction is active", () => {
      const sim = fixture([restriction({ coreOnly: true })]);
      const closed = closedLandings(sim);
      expect(closed).toHaveLength(sim.tags.length);
      for (const m of closed) expect(ids(m)).toEqual([1]);
    });

    it("unions bans and restrictions per attacker", () => {
      const sim = fixture([restriction({ protect: [0], region: [3] })], { landingBans: [ban({ boxes: [[25, 40, 25, 40]], except: ["E"] })] });
      const closed = closedLandings(sim);
      expect(ids(closed[tagOf(sim, "A")])).toEqual([0, 4]);
      expect(ids(closed[tagOf(sim, "E")])).toEqual([0]); // Excepted from the ban, still blocked by the restriction.
      expect(ids(closed[tagOf(sim, "D")])).toEqual([0]);
    });

    it("does not alter the ban masks it was built from", () => {
      const sim = fixture([restriction({ protect: [0] })], { landingBans: [ban()] });
      closedLandings(sim);
      expect(ids(activeLandingBans(sim)[tagOf(sim, "A")])).toEqual([1, 2, 3]);
      expect(ids(closedLandings(sim)[tagOf(sim, "A")])).toEqual([0, 1, 2, 3]);
    });

    it("drops each part when it ends: the ban by date, the restriction by the region", () => {
      const sim = fixture([restriction({ protect: [0] })], { landingBans: [ban()] });
      const a = tagOf(sim, "A");
      sim.tick = 1;
      expect(ids(closedLandings(sim)[a])).toEqual([0]);
      sim.owner[3] = a;
      expect(closedLandings(sim)[a]).toBeNull();
    });
  });
});

describe("fleet placement and landing bans (moveFleets)", () => {
  // Star of sea zones around the home zone 0: zone 1 (two A-B routes), zone 2 (one A-D route).
  // States: 0, 1 A (allies); 2, 3 B (axis); 4 D (axis); 5 C (allies, no routes).
  const allyBan = ban({ boxes: [[10, 30, 20, 50]] }); // Covers B's states: the allies cannot land on B.
  const axisBan = ban({ faction: "axis", boxes: [[0, 0, 3, 3]] }); // Covers A's states: the axis cannot land on A.

  function fixture(config: Partial<SimConfig> = {}, restrictions: LandingRestriction[] = []) {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "A", "B", "B", "D", "C"], land: [], sea: [[0, 2, 1], [1, 3, 1], [0, 4, 2]],
        zones: [{ neighbors: [1, 2] }, { neighbors: [0] }, { neighbors: [0] }],
        lonlat: [[1, 1], [2, 2], [15, 40], [15, 41], [30, 0], [50, 50]],
      }),
      { ...makeScenario({
        A: { faction: "allies" }, B: { faction: "axis" }, D: { faction: "axis" }, C: { faction: "allies" },
      }), landingRestrictions: restrictions },
      { config: { startDate: "1944-06-05", landingBans: [], fleetBattleChance: 0, ...config } },
    );
    setWar(sim, "A", "B");
    setWar(sim, "A", "D");
    setWar(sim, "C", "B");
    setWar(sim, "C", "D");
    sim.fleets = [];
    for (const tag of ["A", "B", "C"]) {
      const c = sim.tags.indexOf(tag);
      sim.homeZone[c] = 0;
      sim.fleets.push({ country: c, zone: 0, target: 0, strength: 10 });
    }
    return sim;
  }
  const targetOf = (sim: SimState, tag: string) => sim.fleets.find((f) => f.country === sim.tags.indexOf(tag))!.target;
  const place = (sim: SimState) => { moveFleets(sim); return ["A", "B", "C"].map((t) => targetOf(sim, t)); };

  it("defaults fleetDefenceWeight to 1", () => {
    expect(DEFAULT_CONFIG.fleetDefenceWeight).toBe(1);
    expect(fixture().config.fleetDefenceWeight).toBe(1);
  });

  it("without bans, the zone with more enemy routes attracts every fleet", () => {
    // A: zone 1 scores 2 against 1, B: only zone 1, C (ally of A at war with both): 0.5 weights, same order.
    expect(place(fixture())).toEqual([1, 1, 1]);
  });

  it("a route closed both ways no longer attracts fleets", () => {
    const sim = fixture({ landingBans: [allyBan, axisBan] });
    // A and its ally C go to zone 2 (the only open route); B (D's ally) follows the same route as support.
    expect(place(sim)).toEqual([2, 2, 2]);
    // Even a large defence weight does not count a route closed both ways.
    expect(place(fixture({ landingBans: [allyBan, axisBan], fleetDefenceWeight: 5 }))).toEqual([2, 2, 2]);
  });

  it("compared with the same map without bans, only the closed route is dropped", () => {
    expect(place(fixture())).not.toEqual(place(fixture({ landingBans: [allyBan, axisBan] })));
    // A ban that expires restores the original placement.
    const sim = fixture({ landingBans: [allyBan, axisBan] });
    sim.tick = 1;
    expect(place(sim)).toEqual([1, 1, 1]);
  });

  it("a one-way closed route counts with fleetDefenceWeight (default 1: unchanged)", () => {
    expect(place(fixture({ landingBans: [allyBan] }))).toEqual([1, 1, 1]);
    expect(place(fixture({ landingBans: [allyBan], fleetDefenceWeight: 1 }))).toEqual([1, 1, 1]);
  });

  it("fleetDefenceWeight 0 drops the one-way closed route for the side that cannot land, not for the enemy", () => {
    // A and C cannot land on B's coast (they would only defend), B still lands on A (open route).
    expect(place(fixture({ landingBans: [allyBan], fleetDefenceWeight: 0 }))).toEqual([2, 1, 2]);
  });

  it("an intermediate fleetDefenceWeight scales the route's score against open routes", () => {
    // Zone 1 has two routes (A: 2 × w), zone 2 one open route (1): zone 1 wins only for w > 0.5.
    expect(place(fixture({ landingBans: [allyBan], fleetDefenceWeight: 0.4 }))[0]).toBe(2);
    expect(place(fixture({ landingBans: [allyBan], fleetDefenceWeight: 0.6 }))[0]).toBe(1);
    // The ally scores half of that, with the same cut-off: 2 × 0.5 × w against 0.5.
    expect(place(fixture({ landingBans: [allyBan], fleetDefenceWeight: 0.4 }))[2]).toBe(2);
    expect(place(fixture({ landingBans: [allyBan], fleetDefenceWeight: 0.6 }))[2]).toBe(1);
  });

  it("a fleet with only one-way-closed routes and weight 0 stays home", () => {
    const sim = fixture({ landingBans: [allyBan], fleetDefenceWeight: 0 });
    // Close the open route for A too: D's land is banned as well.
    sim.config.landingBans = [allyBan, { ...allyBan, name: "D", boxes: [[30, 0, 30, 0]] }];
    expect(place(sim)[0]).toBe(0);
  });

  it("scenario landing restrictions count as closed landings for fleet placement", () => {
    // B's states are protected while D (axis) is held: nobody can land on B, but B can land on A.
    const restrictions: LandingRestriction[] = [{ defender: "B", coreOnly: false, blockedWhileHeldBy: "axis", region: [4] }];
    expect(place(fixture({ fleetDefenceWeight: 0 }, restrictions))).toEqual([2, 1, 2]);
    expect(place(fixture({ fleetDefenceWeight: 1 }, restrictions))).toEqual([1, 1, 1]);
    // Once D's state is lost to the allies the restriction ends and the routes count again.
    const sim = fixture({ fleetDefenceWeight: 0 }, restrictions);
    sim.owner[4] = sim.tags.indexOf("A");
    expect(blockedLandings(sim)).toBeNull();
    expect(place(sim)[0]).toBe(1);
  });
});

describe("army allocation and banned landings", () => {
  const rules: Partial<SimConfig> = {
    startDate: "1944-06-05", frontComparisonMode: "allocated", holdRatio: 1, holdShare: 0, lowPriorityFronts: {},
    enemyPriority: {}, regionPriority: {}, indirectFrontPriority: 1, overseasDistanceFactor: 1, closedLand: [],
    encirclement: false, landingBans: [ban()],
  };

  /**
   * Line 0: A0 -sea- D1 (banned coast). Line 2: A2 -land- D3. A attacks both (100 vs 40).
   * Only state 1 has a position, so every distance is 0.
   */
  function twoLines(config: Partial<SimConfig> = {}, restrictions: LandingRestriction[] = []) {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "D", "A", "D", "X"], land: [[2, 3]], sea: [[0, 1, 0]], capitals: { A: 0, D: 3 },
        lonlat: [undefined, [15, 40]],
      }),
      { ...makeScenario({ A: { faction: "allies" }, D: { faction: "axis" }, X: { faction: "axis" } }), landingRestrictions: restrictions },
      { config: { ...rules, ...config } },
    );
    setWar(sim, "A", "D");
    sim.military.fill(0);
    sim.military[sim.tags.indexOf("A")] = 100;
    sim.military[sim.tags.indexOf("D")] = 40;
    return sim;
  }
  const alloc = (sim: SimState, tag: string) => {
    const fronts = computeFronts(sim), a = allocateArmies(sim, fronts), c = sim.tags.indexOf(tag);
    return { line0: a.get(0)?.get(c) ?? 0, line2: a.get(2)?.get(c) ?? 0, lines: [...fronts.lineCountries.keys()] };
  };

  it("has the two separate lines the tests rely on, with a sea-only and a land target", () => {
    const sim = twoLines(), fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([0, 2]);
    const a = sim.tags.indexOf("A"), d = sim.tags.indexOf("D");
    const tg = fronts.targets.get(a * sim.tags.length + d)!;
    expect([...tg.sea.keys()]).toEqual([1]);
    expect([...tg.land.keys()]).toEqual([3]);
  });

  it("gives a line whose only target is a banned landing no weight (0 with holdShare 0)", () => {
    const r = alloc(twoLines(), "A");
    expect(r.line0).toBe(0);
    expect(r.line2).toBeCloseTo(100, 8);
  });

  it("still holds a banned line for defence (holdRatio × enemy there, by its share of the line's front edges)", () => {
    // holdShare 0: nothing set aside; holdShare 0.5: 0.5 × the enemy's 40 on the line, A being its side's only holder.
    const none = alloc(twoLines({ holdShare: 0 }), "A");
    expect(none.line0).toBeCloseTo(0, 8);
    expect(none.line2).toBeCloseTo(100, 8);
    const held = alloc(twoLines({ holdShare: 0.5 }), "A");
    expect(held.line0).toBeCloseTo(20, 8);
    expect(held.line2).toBeCloseTo(80, 8);
  });

  it("splits the line equally again without the ban or for an excepted attacker", () => {
    for (const config of [{ landingBans: [] }, { landingBans: [ban({ except: ["A"] })] }]) {
      const r = alloc(twoLines(config), "A");
      expect(r.line0).toBeCloseTo(50, 8);
      expect(r.line2).toBeCloseTo(50, 8);
    }
  });

  it("does not ban a landing on a state outside the box, or by the other side's faction", () => {
    expect(alloc(twoLines({ landingBans: [ban({ boxes: [[100, 60, 110, 70]] })] }), "A").line0).toBeCloseTo(50, 8);
    expect(alloc(twoLines({ landingBans: [ban({ faction: "axis" })] }), "A").line0).toBeCloseTo(50, 8);
  });

  it("releases the line after the ban's until date", () => {
    const sim = twoLines();
    expect(alloc(sim, "A").line0).toBe(0);
    sim.tick = 1; // 1944-06-12, after until 1944-06-06.
    const r = alloc(sim, "A");
    expect(r.line0).toBeCloseTo(50, 8);
    expect(r.line2).toBeCloseTo(50, 8);
  });

  it("is open on the until date itself", () => {
    const r = alloc(twoLines({ startDate: "1944-06-06" }), "A");
    expect(r.line0).toBeCloseTo(50, 8);
  });

  it("does not move the defender's allocation on the ban-free side (D is not banned from landing)", () => {
    const sim = twoLines();
    const r = alloc(sim, "D");
    // With no allied army on the banned line the defender sends everything to the line A attacks by land.
    expect(r.line0 + r.line2).toBeCloseTo(40, 8);
    expect(r.line2).toBeGreaterThan(r.line0);
  });

  it("keeps the whole army allocated (nothing is lost on the zero-weight line)", () => {
    for (const holdShare of [0, 0.5, 1]) {
      const sim = twoLines({ holdShare });
      const r = alloc(sim, "A");
      expect(r.line0 + r.line2).toBeCloseTo(100, 8);
    }
  });

  it("a scenario landing restriction closes the sea target the same way, and ends with its region", () => {
    const restrictions: LandingRestriction[] = [{ defender: "D", coreOnly: false, blockedWhileHeldBy: "axis", region: [4] }];
    const sim = twoLines({ landingBans: [] }, restrictions);
    const r = alloc(sim, "A");
    expect(r.line0).toBe(0);
    expect(r.line2).toBeCloseTo(100, 8);
    sim.owner[4] = sim.tags.indexOf("A");
    const open = alloc(sim, "A");
    expect(open.line0).toBeCloseTo(50, 8);
    expect(open.line2).toBeCloseTo(50, 8);
  });

  describe("partly banned line", () => {
    /**
     * Line 0: A0 -land- D1 and A0 -sea- D2 (banned): usableShare 1/2, 2 edges. Line 3: A3 -land- D4, D5: 2 edges.
     * D1 and D2 have no position except D2, so distances stay 0.
     */
    function mixed(config: Partial<SimConfig> = {}) {
      const sim = createSimulation(
        makeMap({
          owners: ["A", "D", "D", "A", "D", "D"], land: [[0, 1], [3, 4], [3, 5]], sea: [[0, 2, 0]], capitals: { A: 0, D: 1 },
          lonlat: [undefined, undefined, [15, 40]],
        }),
        makeScenario({ A: { faction: "allies" }, D: { faction: "axis" } }),
        { config: { ...rules, ...config } },
      );
      setWar(sim, "A", "D");
      sim.military.fill(0);
      sim.military[sim.tags.indexOf("A")] = 100;
      sim.military[sim.tags.indexOf("D")] = 40;
      return sim;
    }
    const a = (sim: SimState, l: number) => allocateArmies(sim, computeFronts(sim)).get(l)?.get(sim.tags.indexOf("A")) ?? 0;

    it("scales the weight by the usable share of the targets (land counts as usable)", () => {
      const sim = mixed(), fronts = computeFronts(sim);
      expect([...fronts.lineCountries.keys()]).toEqual([0, 3]);
      const t = fronts.targets.get(sim.tags.indexOf("A") * sim.tags.length + sim.tags.indexOf("D"))!;
      expect([...t.land.keys()].sort()).toEqual([1, 4, 5]);
      expect([...t.sea.keys()]).toEqual([2]);
      expect(a(sim, 0)).toBeCloseTo(100 / 3, 8);
      expect(a(sim, 3)).toBeCloseTo(200 / 3, 8);
    });

    it("is split in proportion to the edges without the ban", () => {
      const sim = mixed({ landingBans: [] });
      expect(a(sim, 0)).toBeCloseTo(50, 8);
      expect(a(sim, 3)).toBeCloseTo(50, 8);
    });

    it("keeps the hold amount on a line that still has usable targets", () => {
      const sim = mixed({ holdShare: 0.5 });
      // First pass: A 100/3 and 200/3 against D's 20 and 20; hold 20 on each, the remaining 60 by weight (20:40).
      expect(a(sim, 0)).toBeCloseTo(20 + 20, 8);
      expect(a(sim, 3)).toBeCloseTo(20 + 40, 8);
    });

    it("returns to the plain weights after the ban ends", () => {
      const sim = mixed();
      sim.tick = 1;
      expect(a(sim, 0)).toBeCloseTo(50, 8);
      expect(a(sim, 3)).toBeCloseTo(50, 8);
    });
  });
});

describe("historical preset: Italian landing restriction", () => {
  const map = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8")) as MapData;
  const scenario = JSON.parse(
    readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"),
  ) as Scenario;
  const restriction = scenario.landingRestrictions![0];
  const lonLat = (s: number) => map.states[s].lonlat!;

  it("is the restriction of the defender ITA, blocked while the axis holds the region", () => {
    expect(restriction.defender).toBe("ITA");
    expect(restriction.blockedWhileHeldBy).toBe("axis");
    expect(restriction.region.length).toBeGreaterThan(0);
  });

  it("has only Libya and Tunisia in its region: owners ITA or FRA, inside lon 7.9-25.2 and lat 18-37.6", () => {
    for (const s of restriction.region) {
      expect(["ITA", "FRA"]).toContain(map.states[s].owner);
      const [lon, lat] = lonLat(s);
      expect(lon).toBeGreaterThanOrEqual(7.9);
      expect(lon).toBeLessThanOrEqual(25.2);
      expect(lat).toBeGreaterThanOrEqual(18);
      expect(lat).toBeLessThanOrEqual(37.6);
    }
    expect(new Set(restriction.region.map((s) => map.states[s].owner))).toEqual(new Set(["ITA", "FRA"]));
  });

  it("lists every original Italian state in lon 9-25.2, lat 18-34 (Libya), and no other Italian state", () => {
    const libya = map.states.flatMap((st, i) => {
      if (st.owner !== "ITA" || !st.lonlat) return [];
      const [lon, lat] = st.lonlat;
      return lon >= 9 && lon <= 25.2 && lat >= 18 && lat <= 34 ? [i] : [];
    });
    expect(libya.length).toBeGreaterThan(0);
    const ita = restriction.region.filter((s) => map.states[s].owner === "ITA");
    expect([...ita].sort((p, q) => p - q)).toEqual(libya);
    // Sicily, Sardinia and the Dodecanese are not part of it.
    expect(ita.every((s) => lonLat(s)[1] <= 34)).toBe(true);
  });

  it("takes Tunisia from the French states: north of 30°N and east of the Algerian border", () => {
    const fra = restriction.region.filter((s) => map.states[s].owner === "FRA");
    expect(fra.length).toBeGreaterThan(0);
    for (const s of fra) {
      const [lon, lat] = lonLat(s);
      expect(lon).toBeGreaterThanOrEqual(8.3);
      expect(lat).toBeGreaterThanOrEqual(30);
    }
  });

  it("contains no Algerian state west of 8°E and no Egyptian (UK) state", () => {
    const region = new Set(restriction.region);
    const algeria = map.states.flatMap((st, i) => (st.owner === "FRA" && st.lonlat && st.lonlat[0] < 8 ? [i] : []));
    expect(algeria.length).toBeGreaterThan(0); // The map does have such states.
    expect(algeria.filter((s) => region.has(s))).toEqual([]);
    expect(restriction.region.filter((s) => map.states[s].owner === "UK")).toEqual([]);
    const egyptUK = map.states.flatMap((st, i) => (st.owner === "UK" && st.lonlat && st.lonlat[0] > 25.2 ? [i] : []));
    expect(egyptUK.filter((s) => region.has(s))).toEqual([]);
  });

  it("has no duplicates and valid state ids", () => {
    expect(new Set(restriction.region).size).toBe(restriction.region.length);
    for (const s of restriction.region) {
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(map.states.length);
    }
  });

  it("is compiled by init with the full region, and blocks the Italian homeland while the axis holds it", () => {
    const sim = createSimulation(map, scenario);
    const italy = sim.tags.indexOf("ITA");
    expect(sim.restrictions[0].region.length).toBe(restriction.region.length);
    const blocked = blockedLandings(sim)!;
    expect(blocked).not.toBeNull();
    const core = map.states.flatMap((st, i) => (st.owner === "ITA" && st.core ? [i] : []));
    expect(core.length).toBeGreaterThan(0);
    for (const s of core) expect(blocked[s]).toBe(1);
    // Libya (not core) is not protected, so a landing there stays possible.
    for (const s of restriction.region.filter((r) => map.states[r].owner === "ITA")) expect(blocked[s]).toBe(0);
    expect(sim.origOwner[core[0]]).toBe(italy);
  });

  it("lifts the Italian homeland protection once no region state is held by the axis", () => {
    const sim = createSimulation(map, scenario);
    const uk = sim.tags.indexOf("UK"), ita = sim.tags.indexOf("ITA");
    expect(sim.faction[uk]).toBe("allies");
    const home = map.states.findIndex((st) => st.owner === "ITA" && st.core);
    expect(blockedLandings(sim)![home]).toBe(1);
    for (const s of restriction.region) sim.owner[s] = uk;
    expect(blockedLandings(sim)![home]).toBe(0); // (The Japanese restriction is a separate one.)
    // A single Axis-held state brings it back.
    sim.owner[restriction.region[0]] = ita;
    expect(blockedLandings(sim)![home]).toBe(1);
  });
});
