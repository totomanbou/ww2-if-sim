import { describe, expect, it } from "vitest";
import { capitulate, capitulationReceiver, capitulationRecipient, checkCapitulations, lostShare } from "../capitulation";
import { setOwner } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { step } from "../engine";
import { headline } from "../../ui/news";
import { createWeeklySimulation as createSimulation, makeMap, makeScenario, setWar } from "./helpers";

const rules = {
  capitulateOnCapitalLoss: [],
  capitulateOnContinentLoss: [],
  encirclement: false,
  advanceRate: 0,
  lossRate: 0,
  fleetBattleChance: 0,
  growthMode: "yearly",
} satisfies Partial<SimConfig>;

function fixture(land: [number, number][] = []) {
  const sim = createSimulation(makeMap({
    owners: ["ITA", "ITA", "ITA", "ITA", "ITA", "ITA", "GER", "UK", "UK", "N", "GER"],
    land,
    core: [true, true, true, true, true, false],
    cities: { London: 9, Moscow: 9, Honolulu: 9, Paris: 9, Rome: 9, Berlin: 9, Tokyo: 9 },
  }), makeScenario({
    ITA: { name: "イタリア", formalName: "イタリア王国", faction: "axis" },
    GER: { name: "ドイツ", formalName: "ドイツ国", faction: "axis" },
    UK: { name: "イギリス", formalName: "イギリス連合王国", faction: "allies" },
    N: {},
  }), { config: rules });
  const [ita, ger, uk] = ["ITA", "GER", "UK"].map((tag) => sim.tags.indexOf(tag));
  setWar(sim, "ITA", "UK");
  for (const state of [0, 1, 2, 3]) setOwner(sim, state, uk);
  // Italy also holds Allied-origin land; Britain's own capital is still British.
  setOwner(sim, 8, ita);
  sim.facing[ita * sim.tags.length + uk] = 100;
  return { sim, ita, ger, uk };
}

describe("capitulation occupier defaults", () => {
  it("assigns Germany to occupy Italy's remaining territory", () => {
    expect(DEFAULT_CONFIG.capitulationOccupier).toEqual({ ITA: "GER" });
    expect(fixture().sim.config.capitulationOccupier).toEqual({ ITA: "GER" });
  });
});

describe("capitulationReceiver", () => {
  it("prefers the active same-faction occupier over the enemy recipient", () => {
    const { sim, ita, ger, uk } = fixture();
    expect(capitulationRecipient(sim, ita)).toBe(uk);
    expect(capitulationReceiver(sim, ita)).toBe(ger);
  });

  it.each(["capitulated", "enemy faction", "neutral faction", "self", "missing", "unconfigured"] as const)(
    "falls back to the enemy when the occupier is %s", (invalid) => {
      const { sim, ita, ger, uk } = fixture();
      if (invalid === "capitulated") sim.capitulated[ger] = 1;
      if (invalid === "enemy faction") sim.faction[ger] = "allies";
      if (invalid === "neutral faction") sim.faction[ita] = sim.faction[ger] = "neutral";
      if (invalid === "self") sim.config.capitulationOccupier = { ITA: "ITA" };
      if (invalid === "missing") sim.config.capitulationOccupier = { ITA: "ABSENT" };
      if (invalid === "unconfigured") sim.config.capitulationOccupier = {};
      expect(capitulationRecipient(sim, ita)).toBe(uk);
      expect(capitulationReceiver(sim, ita)).toBe(uk);
    },
  );

  it("uses a valid occupier even when there is no enemy recipient", () => {
    const { sim, ita, ger } = fixture();
    sim.atWar.fill(0);
    expect(capitulationRecipient(sim, ita)).toBe(-1);
    expect(capitulationReceiver(sim, ita)).toBe(ger);
  });
});

describe("occupier territory transfers", () => {
  it("gives the remaining homeland to the occupier and preserves existing enemy holdings", () => {
    const { sim, ita, ger, uk } = fixture();
    expect(lostShare(sim, ita)).toBeCloseTo(0.6, 8);
    expect(sim.owner[sim.capital[ita]]).toBe(uk);
    expect(checkCapitulations(sim)).toEqual([[ita, ger]]);
    expect(sim.owner[4]).toBe(ger);
    expect(Array.from(sim.owner.slice(0, 4))).toEqual([uk, uk, uk, uk]);
    expect(sim.capitulated[ita]).toBe(1);
    expect(sim.military[ita]).toBe(0);
    for (let c = 0; c < sim.tags.length; c++) {
      expect(sim.atWar[ita * sim.tags.length + c]).toBe(0);
      expect(sim.atWar[c * sim.tags.length + ita]).toBe(0);
    }
  });

  it("leaves non-core original colonies with the capitulating country", () => {
    const { sim, ita, ger } = fixture();
    expect(sim.origOwner[5]).toBe(ita);
    expect(sim.core[5]).toBe(0);
    expect(checkCapitulations(sim)).toEqual([[ita, ger]]);
    expect(sim.owner[5]).toBe(ita);
  });

  it("gives Allied-origin land held by Italy to Germany", () => {
    const { sim, ita, ger, uk } = fixture();
    expect(sim.origOwner[8]).toBe(uk);
    expect(sim.owner[8]).toBe(ita);
    expect(checkCapitulations(sim)).toEqual([[ita, ger]]);
    expect(sim.owner[8]).toBe(ger);
  });

  it("returns the occupying ally's original land held by Italy to that occupier", () => {
    const { sim, ita, ger } = fixture();
    setOwner(sim, 10, ita);
    expect(sim.origOwner[10]).toBe(ger);
    expect(sim.owner[sim.capital[ger]]).toBe(ger);
    expect(checkCapitulations(sim)).toEqual([[ita, ger]]);
    expect(sim.owner[10]).toBe(ger);
  });

  it.each(["capitulated", "enemy faction"] as const)(
    "keeps the enemy transfer when the configured occupier is %s", (invalid) => {
      const { sim, ita, ger, uk } = fixture();
      if (invalid === "capitulated") sim.capitulated[ger] = 1;
      else sim.faction[ger] = "allies";
      expect(checkCapitulations(sim)).toEqual([[ita, uk]]);
      expect(sim.owner[4]).toBe(uk);
      expect(sim.owner[8]).toBe(uk);
      expect(sim.owner[5]).toBe(ita);
    },
  );
});

describe("occupation news through step", () => {
  it("logs the occupier, occupied flag and text, and uses formal names in the headline", () => {
    const { sim, ita, ger } = fixture();
    step(sim);
    const events = sim.events.filter((event) => event.type === "capitulation");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tick: 0,
      date: "1939-09-01",
      countries: ["ITA", "GER"],
      occupied: true,
      text: `${sim.names[ita]}が降伏。残る領土は${sim.names[ger]}が占領`,
    });
    expect(headline(events[0], sim.scenario)).toBe("【速報】イタリア王国が降伏 ドイツ国が残る領土を占領");
    expect(sim.owner[4]).toBe(ger);
    expect(sim.owner[5]).toBe(ita);
    expect(sim.result).toBeNull();
  });

  it.each(["capitulated", "enemy faction"] as const)(
    "logs ordinary enemy capitulation news when the occupier is %s", (invalid) => {
      const { sim, ita, ger, uk } = fixture();
      if (invalid === "capitulated") sim.capitulated[ger] = 1;
      else sim.faction[ger] = "allies";
      step(sim);
      const events = sim.events.filter((event) => event.type === "capitulation");
      expect(events).toHaveLength(1);
      expect(events[0].countries).toEqual(["ITA", "UK"]);
      expect(events[0].occupied).toBeUndefined();
      expect(events[0].text).toBe(`${sim.names[ita]}が降伏。残る領土は${sim.names[uk]}へ`);
      expect(headline(events[0], sim.scenario)).toBe("【速報】イタリア王国がイギリス連合王国に降伏");
    },
  );
});

describe("surrender stays in effect during allied occupation", () => {
  it.each(["GER", "N"])("does not revive Italy when %s retakes one of its former states", (captor) => {
    const { sim, ita, ger, uk } = fixture([[captor === "GER" ? 6 : 9, 1]]);
    expect(checkCapitulations(sim)).toEqual([[ita, ger]]);
    const by = sim.tags.indexOf(captor);
    sim.faction[by] = "axis";
    setWar(sim, captor, "UK");
    sim.military[by] = 1000;
    sim.military[uk] = 1;
    sim.config.advanceRate = sim.config.advanceMax = 1;

    step(sim);

    expect(sim.owner[1]).toBe(ger);
    expect(sim.capitulated[ita]).toBe(1);
    expect(sim.revivedAwaitingCapital[ita]).toBe(0);
    expect(sim.events.filter((e) => e.type === "revival" && e.countries[0] === "ITA")).toEqual([]);
  });

  it("does not revive Italy when its enemy surrenders to Germany and returns Italian land in bulk", () => {
    const { sim, ita, ger, uk } = fixture();
    checkCapitulations(sim);
    const returned: import("../combat").Revival[] = [];
    capitulate(sim, uk, ger, returned);
    expect(Array.from(sim.owner.slice(0, 5))).toEqual([ger, ger, ger, ger, ger]);
    expect(sim.capitulated[ita]).toBe(1);
    expect(returned).toEqual([]);
  });

  it("hands occupied Italian land onward when Germany itself surrenders to another ally", () => {
    const { sim, ita, ger } = fixture();
    checkCapitulations(sim);
    const other = sim.tags.indexOf("N");
    sim.faction[other] = "axis";
    const returned: import("../combat").Revival[] = [];
    capitulate(sim, ger, other, returned);
    expect(sim.owner[4]).toBe(other);
    expect(sim.capitulated[ita]).toBe(1);
    expect(returned).toEqual([]);
  });

  it("still permits ordinary liberation when the occupation rule has been removed", () => {
    const { sim, ita, ger, uk } = fixture([[6, 1]]);
    checkCapitulations(sim);
    sim.config.capitulationOccupier = {};
    setWar(sim, "GER", "UK");
    sim.military[ger] = 1000;
    sim.military[uk] = 1;
    sim.config.advanceRate = sim.config.advanceMax = 1;
    step(sim);
    expect(sim.owner[1]).toBe(ita);
    expect(sim.capitulated[ita]).toBe(0);
    expect(sim.events.some((e) => e.type === "revival" && e.countries[0] === "ITA")).toBe(true);
  });
});
