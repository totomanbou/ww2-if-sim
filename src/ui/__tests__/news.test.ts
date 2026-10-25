import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createSimulation, parseDate, step, tickTime } from "../../sim";
import type { CountrySetup, EventType, Scenario, SimEvent, SimMap, SimState } from "../../sim";
import { deathToll, endHeadline, formatPeople, headline } from "../news";

function country(name: string, industry = 0, formalName?: string): CountrySetup {
  return { name, industry, formalName, color: "#888888", faction: "neutral", shipbuilding: 0, stability: 1 };
}

const scenario: Scenario = {
  name: "Headline test",
  seed: 1,
  wars: [],
  countries: {
    A: country("A", 10),
    B: country("B", 30),
    C: country("C", 20),
    D: country("D", 30),
    E: country("E", 30),
    FORMAL: country("通称", 1, "正式国名"),
    NAMED: country("通常国名", 1),
    TARGET: country("相手国", 100),
  },
};

function event(type: EventType, countries: string[], split?: number): SimEvent {
  return { tick: 0, date: "1939-09-01", type, countries, split, text: "Ignored event text" };
}

const nameCases = [
  { tag: "FORMAL", name: "正式国名" },
  { tag: "NAMED", name: "通常国名" },
  { tag: "UNKNOWN", name: "UNKNOWN" },
];

describe("headline", () => {
  describe("war declarations", () => {
    it.each(nameCases)("uses $name for attacker $tag", ({ tag, name }) => {
      expect(headline(event("war", [tag, "TARGET"], 1), scenario))
        .toBe(`【速報】${name}が相手国に宣戦布告`);
    });

    it.each(nameCases)("uses $name for defender $tag", ({ tag, name }) => {
      expect(headline(event("war", ["TARGET", tag], 1), scenario))
        .toBe(`【速報】相手国が${name}に宣戦布告`);
    });

    it("splits attackers and defenders before sorting each side by industry", () => {
      expect(headline(event("war", ["A", "B", "C", "D"], 2), scenario))
        .toBe("【速報】B・AがD・Cに宣戦布告");
    });

    it("defaults a missing split to one attacker", () => {
      const declaration: SimEvent = {
        tick: 0, date: "1939-09-01", type: "war", countries: ["A", "B", "C"], text: "",
      };
      expect(headline(declaration, scenario)).toBe("【速報】AがB・Cに宣戦布告");
    });

    it.each([
      { countries: [] },
      { countries: ["A"] },
      { countries: ["A", "B"] },
    ])("returns null without defenders ($countries)", ({ countries }) => {
      expect(headline(event("war", countries, countries.length), scenario)).toBeNull();
    });

    it("returns null without defenders when split is missing", () => {
      expect(headline(event("war", ["A"]), scenario)).toBeNull();
    });

    it("returns null without attackers", () => {
      expect(headline(event("war", ["A", "B"], 0), scenario)).toBeNull();
    });
  });

  describe("country lists", () => {
    const lists = [
      { tags: ["A"], expected: "A" },
      { tags: ["A", "B"], expected: "B・A" },
      { tags: ["A", "C", "B"], expected: "B・C・A" },
      { tags: ["D", "B", "A"], expected: "D・B・A" },
      { tags: ["A", "D", "B", "C"], expected: "D・Bほか2か国" },
      { tags: ["A", "E", "D", "B", "C"], expected: "E・Dほか3か国" },
    ];

    it.each(lists)("formats attackers $tags as $expected", ({ tags, expected }) => {
      expect(headline(event("war", [...tags, "TARGET"], tags.length), scenario))
        .toBe(`【速報】${expected}が相手国に宣戦布告`);
    });

    it.each(lists)("formats defenders $tags as $expected", ({ tags, expected }) => {
      expect(headline(event("war", ["TARGET", ...tags], 1), scenario))
        .toBe(`【速報】相手国が${expected}に宣戦布告`);
    });
  });

  describe("capitulations", () => {
    it.each(nameCases)("uses $name for capitulating country $tag", ({ tag, name }) => {
      expect(headline(event("capitulation", [tag, "TARGET"]), scenario))
        .toBe(`【速報】${name}が相手国に降伏`);
    });

    it.each(nameCases)("uses $name for recipient $tag", ({ tag, name }) => {
      expect(headline(event("capitulation", ["TARGET", tag]), scenario))
        .toBe(`【速報】相手国が${name}に降伏`);
    });

    it.each(nameCases)("omits the recipient when $tag capitulates without one", ({ tag, name }) => {
      expect(headline(event("capitulation", [tag]), scenario)).toBe(`【速報】${name}が降伏`);
    });
  });

  const otherTypes: Exclude<EventType, "war" | "capitulation">[] = [
    "capitalFall", "capitalRecapture", "revival", "transfer", "cityFall", "cityRecapture", "fleetBattle", "victory", "stalemate",
  ];
  it.each(otherTypes)("returns null for %s", (type) => {
    expect(headline(event(type, ["A", "B"]), scenario)).toBeNull();
  });
});

describe("historical headlines through 1941-12-31", () => {
  const map: SimMap = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8"));
  const historical: Scenario = JSON.parse(
    readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"),
  );
  let events: SimEvent[];

  beforeAll(() => {
    const sim = createSimulation(map, historical, { seed: historical.seed });
    const cutoff = parseDate("1941-12-31");
    while (!sim.result && tickTime(sim.startMs, sim.tick) <= cutoff) step(sim);
    expect(tickTime(sim.startMs, sim.tick)).toBeGreaterThan(cutoff);
    events = sim.events;
  });

  it("includes Japan's declaration on the USA, UK and other countries", () => {
    const headlines = events.map((e) => headline(e, historical));
    expect(headlines).toContainEqual(expect.stringMatching(
      /^【速報】大日本帝国がアメリカ合衆国・イギリスほか\d+か国に宣戦布告$/,
    ));
  });

  it("reports the UK's and France's 1939-09-03 declaration on Germany in the correct direction", () => {
    const declaration = historical.wars.find((war) => war.date === "1939-09-03");
    expect(declaration).toBeDefined();
    // Wars are logged on the first half-week tick on/after the scheduled date (1939-09-04 at noon).
    const declarationEvent = events.find((e) => e.type === "war"
      && e.countries.join(",") === [...declaration!.a, ...declaration!.b].join(","));
    expect(declarationEvent).toBeDefined();
    expect(declarationEvent!.date).toBe("1939-09-04");
    expect(declarationEvent!.split).toBe(5);
    expect(headline(declarationEvent!, historical))
      .toBe("【速報】イギリス・フランス共和国ほか3か国がドイツ国に宣戦布告");
  });

  it("includes a capitulation headline for the Republic of Poland", () => {
    const headlines = events.filter((e) => e.type === "capitulation").map((e) => headline(e, historical));
    expect(headlines).toContainEqual(expect.stringMatching(/^【速報】ポーランド共和国が(?:.+に)?降伏$/));
  });
});

function casualtyState(losses: SimState["losses"], peoplePerArmyLoss = 12_000, peoplePerNavyLoss = 370): SimState {
  return { losses, config: { peoplePerArmyLoss, peoplePerNavyLoss } } as unknown as SimState;
}

describe("formatPeople", () => {
  it.each([
    { people: 74_520_000, expected: "約7,450万人" },
    { people: 66_990_000, expected: "約6,700万人" },
    { people: 123_456, expected: "約12万人" },
    { people: 9_999_999, expected: "約1,000万人" },
    { people: 1_000_000, expected: "約100万人" },
    { people: 10_000, expected: "約1万人" },
    { people: 0, expected: "約0万人" },
  ])("formats $people as $expected", ({ people, expected }) => {
    expect(formatPeople(people)).toBe(expected);
  });
});

describe("deathToll", () => {
  it("returns zero with no combat losses", () => {
    expect(deathToll(casualtyState({ axis: { army: 0, navy: 0 }, allies: { army: 0, navy: 0 } }))).toBe(0);
  });

  it.each([
    { losses: { axis: { army: 1, navy: 0 }, allies: { army: 0, navy: 0 } }, expected: 12_000 },
    { losses: { axis: { army: 0, navy: 1 }, allies: { army: 0, navy: 0 } }, expected: 370 },
    { losses: { axis: { army: 0, navy: 0 }, allies: { army: 1, navy: 0 } }, expected: 12_000 },
    { losses: { axis: { army: 0, navy: 0 }, allies: { army: 0, navy: 1 } }, expected: 370 },
  ])("counts each loss counter with its arm's factor: %j", ({ losses, expected }) => {
    expect(deathToll(casualtyState(losses))).toBe(expected);
  });

  it.each([[12_000, 370], [100, 1], [0, 0]])("uses the configured %s dead per army loss and %s per navy loss", (perArmy, perNavy) => {
    const sim = casualtyState({ axis: { army: 1.5, navy: 2 }, allies: { army: 3, navy: 4 } }, perArmy, perNavy);
    expect(deathToll(sim)).toBe(4.5 * perArmy + 6 * perNavy);
  });
});

describe("endHeadline", () => {
  it("includes the rounded death toll and exact closing text", () => {
    const sim = casualtyState({ axis: { army: 1_000, navy: 400 }, allies: { army: 900, navy: 480 } });
    expect(deathToll(sim)).toBe(1_900 * 12_000 + 880 * 370);
    expect(endHeadline(sim)).toBe("約2,310万人もの犠牲者を出した第二次世界大戦終結");
  });

  it("uses the simulation's configured people per loss", () => {
    const sim = casualtyState({ axis: { army: 1, navy: 2 }, allies: { army: 3, navy: 4 } }, 2_000_000, 500_000);
    expect(endHeadline(sim)).toBe("約1,100万人もの犠牲者を出した第二次世界大戦終結"); // 4 × 2,000,000 + 6 × 500,000
  });
});
