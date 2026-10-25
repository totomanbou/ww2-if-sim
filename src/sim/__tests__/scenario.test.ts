import { describe, expect, it } from "vitest";
import {
  applyScenarioFile,
  capitalOf,
  clampIndustry,
  clampStability,
  entryDates,
  INDUSTRY_MAX,
  SCENARIO_FORMAT,
  toScenarioFile,
  warsOf,
} from "../scenario";
import { makeMap, makeScenario } from "./helpers";

function makeFixture() {
  const map = makeMap({ owners: ["A", "A", "B", "B"], land: [], capitals: { A: 1, B: 3 } });
  const base = makeScenario(
    {
      A: { faction: "axis", industry: 20, stability: 0.8 },
      B: { faction: "allies", industry: 30, stability: 0.7 },
    },
    [{ date: "1939-09-01", a: ["A"], b: ["B"] }],
    [0],
  );
  return { map, base };
}

describe("entryDates", () => {
  it("finds each country's earliest war across both sides and leaves peaceful countries null", () => {
    const scenario = makeScenario({ A: {}, B: {}, C: {}, D: {} }, [
      { date: "1941-06-22", a: ["A"], b: ["B", "C"] },
      { date: "1939-09-01", a: ["B"], b: ["A"] },
      { date: "1940-05-10", a: ["C"], b: ["A"] },
    ]);

    expect(entryDates(scenario)).toEqual({
      A: "1939-09-01",
      B: "1939-09-01",
      C: "1940-05-10",
      D: null,
    });
  });
});

describe("warsOf", () => {
  it("sorts a country's wars by date and returns the entire opposing side", () => {
    const scenario = makeScenario({ A: {}, B: {}, C: {}, D: {} }, [
      { date: "1941-06-22", a: ["A", "D"], b: ["B", "C"], note: "Later" },
      { date: "1939-09-01", a: ["B", "D"], b: ["A", "C"], note: "Earlier" },
      { date: "1938-01-01", a: ["B"], b: ["C"] },
      { date: "1940-05-10", a: ["A"], b: ["D"] },
    ]);

    expect(warsOf(scenario, "A")).toEqual([
      { date: "1939-09-01", enemies: ["B", "D"], note: "Earlier" },
      { date: "1940-05-10", enemies: ["D"], note: undefined },
      { date: "1941-06-22", enemies: ["B", "C"], note: "Later" },
    ]);
  });

  it("returns no wars for a peaceful country", () => {
    const scenario = makeScenario({ A: {}, B: {}, C: {} }, [
      { date: "1939-09-01", a: ["A"], b: ["B"] },
    ]);
    expect(warsOf(scenario, "C")).toEqual([]);
  });
});

describe("capitalOf", () => {
  const map = makeMap({
    owners: ["A", "A", "B"],
    land: [],
    capitals: { A: 1 },
  });

  it("always uses the map's original capital", () => {
    expect(capitalOf(map, "A")).toBe(1);
    expect(capitalOf(map, "B")).toBe(2);
  });

  it("falls back to the country's first original state only when map metadata is invalid", () => {
    const invalid = { ...map, countries: { ...map.countries, A: { defaultCapital: 99 } } };
    expect(capitalOf(invalid, "A")).toBe(0);
    expect(capitalOf(map, "NO_TERRITORY")).toBe(-1);
  });
});

describe("clampIndustry", () => {
  it.each([
    [-1, 0],
    [0, 0],
    [12.5, 12.5],
    [INDUSTRY_MAX, INDUSTRY_MAX],
    [INDUSTRY_MAX + 1, INDUSTRY_MAX],
    [NaN, 0],
    [Infinity, 0],
    [-Infinity, 0],
  ])("clamps %s to %s", (input, expected) => {
    expect(clampIndustry(input)).toBe(expected);
  });
});

describe("clampStability", () => {
  it.each([
    [-0.1, 0],
    [0, 0],
    [0.4, 0.4],
    [1, 1],
    [1.1, 1],
    [NaN, 0],
    [Infinity, 0],
    [-Infinity, 0],
  ])("clamps %s to %s", (input, expected) => {
    expect(clampStability(input)).toBe(expected);
  });
});

describe("scenario files", () => {
  it("round trips editable fields (including the faction) and seed while preserving the base preset's fixed fields", () => {
    const { map, base } = makeFixture();
    const edited = structuredClone(base);
    Object.assign(edited.countries.A, {
      industry: 75, shipbuilding: 12.5, stability: 0.4, capital: 0, faction: "neutral",
    });
    Object.assign(edited.countries.B, {
      industry: 125, shipbuilding: 37, stability: 0.9, capital: 2, faction: "axis",
    });
    edited.seed = 42;
    edited.wars = [{ date: "1941-01-01", a: ["B"], b: ["A"] }];
    edited.stateOverrides = { "2": { invulnerable: true } };

    const text = JSON.stringify(toScenarioFile(edited, map));
    const { scenario, warnings } = applyScenarioFile(text, base, map);

    expect(warnings).toEqual([]);
    expect(scenario.seed).toBe(edited.seed);
    for (const tag of ["A", "B"]) {
      const { industry, shipbuilding, stability } = edited.countries[tag];
      expect(scenario.countries[tag]).toMatchObject({ industry, shipbuilding, stability });
      expect(scenario.countries[tag]).not.toHaveProperty("capital");
      expect(JSON.parse(text).countries[tag]).not.toHaveProperty("capital");
      expect(scenario.countries[tag].faction).toBe(edited.countries[tag].faction);
    }
    expect(scenario.wars).toEqual(base.wars);
    expect(scenario.stateOverrides).toEqual(base.stateOverrides);
  });

  it("toScenarioFile writes the faction of every country", () => {
    const { map, base } = makeFixture();
    const file = toScenarioFile(base, map);
    expect(file.countries.A.faction).toBe("axis");
    expect(file.countries.B.faction).toBe("allies");
    base.countries.B.faction = "neutral";
    expect(JSON.parse(JSON.stringify(toScenarioFile(base, map))).countries.B.faction).toBe("neutral");
  });

  it.each(["axis", "allies", "neutral"] as const)("applies a valid saved faction %s without a warning", (faction) => {
    const { map, base } = makeFixture();
    base.countries.A.faction = faction === "axis" ? "allies" : "axis";
    const file = toScenarioFile(base, map);
    file.countries.A.faction = faction;

    const { scenario, warnings } = applyScenarioFile(JSON.stringify(file), base, map);

    expect(scenario.countries.A.faction).toBe(faction);
    expect(warnings).toEqual([]);
  });

  it.each(["fascist", "", null, 3, undefined])("ignores the invalid saved faction %j with a warning and keeps the preset's", (faction) => {
    const { map, base } = makeFixture();
    const file = toScenarioFile(base, map);
    // `undefined` is dropped by JSON; write the raw text so that every case is a present-but-invalid field.
    const text = JSON.stringify({ ...file, countries: { ...file.countries, A: { ...file.countries.A, faction: faction ?? null } } });

    const { scenario, warnings } = applyScenarioFile(text, base, map);

    expect(scenario.countries.A.faction).toBe("axis");
    expect(scenario.countries.B.faction).toBe("allies");
    expect(warnings).toEqual([expect.stringContaining("陣営")]);
  });

  it("keeps the preset's faction when the field is absent (files saved before factions could be changed)", () => {
    const { map, base } = makeFixture();
    const file = toScenarioFile(base, map);
    for (const c of Object.values(file.countries)) delete c.faction;
    const text = JSON.stringify(file);
    expect(text).not.toContain("faction");

    const { scenario, warnings } = applyScenarioFile(text, base, map);

    expect(scenario.countries.A.faction).toBe("axis");
    expect(scenario.countries.B.faction).toBe("allies");
    expect(warnings).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    const { map, base } = makeFixture();
    expect(() => applyScenarioFile("{", base, map)).toThrow();
  });

  it.each([undefined, "another-format"])("rejects a file with format %s", (format) => {
    const { map, base } = makeFixture();
    const text = JSON.stringify({ ...toScenarioFile(base, map), format });
    expect(() => applyScenarioFile(text, base, map)).toThrow();
  });

  it("ignores an unknown country with a warning", () => {
    const { map, base } = makeFixture();
    const file = toScenarioFile(base, map);
    expect(file.format).toBe(SCENARIO_FORMAT);
    file.countries.UNKNOWN = { industry: 50, shipbuilding: 10, stability: 0.5 };

    const { scenario, warnings } = applyScenarioFile(JSON.stringify(file), base, map);

    expect(scenario.countries).toEqual(base.countries);
    expect(warnings).toEqual([expect.stringContaining("UNKNOWN")]);
  });

  it("clamps excessive industry and negative stability with a warning for each", () => {
    const { map, base } = makeFixture();
    const file = toScenarioFile(base, map);
    file.countries.A.industry = INDUSTRY_MAX + 1;
    file.countries.A.stability = -0.2;

    const { scenario, warnings } = applyScenarioFile(JSON.stringify(file), base, map);

    expect(scenario.countries.A.industry).toBe(INDUSTRY_MAX);
    expect(scenario.countries.A.stability).toBe(0);
    expect(warnings).toHaveLength(2);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("陸軍生産力"),
      expect.stringContaining("政治安定性"),
    ]));
  });

  it.each([0, 2, -1, 999])("ignores every obsolete saved capital %s and warns while retaining other fields", (capital) => {
    const { map, base } = makeFixture();
    const file = toScenarioFile(base, map);
    Object.assign(file.countries.A, { capital, industry: 60 });

    const { scenario, warnings } = applyScenarioFile(JSON.stringify(file), base, map);

    expect(capitalOf(map, "A")).toBe(1);
    expect(scenario.countries.A).not.toHaveProperty("capital");
    expect(scenario.countries.A.industry).toBe(60);
    expect(warnings).toEqual([expect.stringContaining("首都")]);
  });

  it("clamps excessive shipbuilding to 1000 with a warning", () => {
    const { map, base } = makeFixture();
    const file = toScenarioFile(base, map);
    file.countries.A.shipbuilding = 1001;

    const { scenario, warnings } = applyScenarioFile(JSON.stringify(file), base, map);

    expect(scenario.countries.A.shipbuilding).toBe(1000);
    expect(warnings).toEqual([expect.stringContaining("海軍生産力")]);
  });

  it("keeps all base capitals and warns on a map size mismatch while applying other edits", () => {
    const { map, base } = makeFixture();
    const file = toScenarioFile(base, map);
    file.mapStates = map.states.length + 1;
    file.countries.A.industry = 60;

    const { scenario, warnings } = applyScenarioFile(JSON.stringify(file), base, map);

    expect(capitalOf(map, "A")).toBe(1);
    expect(capitalOf(map, "B")).toBe(3);
    expect(scenario.countries.A.industry).toBe(60);
    expect(warnings).toEqual([expect.stringContaining("地図")]);
  });

  it("keeps the base seed and warns when the saved seed is not an integer", () => {
    const { map, base } = makeFixture();
    const file = toScenarioFile(base, map);
    file.seed = 1.5;

    const { scenario, warnings } = applyScenarioFile(JSON.stringify(file), base, map);

    expect(scenario.seed).toBe(base.seed);
    expect(warnings).toEqual([expect.stringContaining("シード")]);
  });

  it("does not mutate the base scenario or its nested countries", () => {
    const { map, base } = makeFixture();
    const original = structuredClone(base);
    const file = toScenarioFile(base, map);
    file.name = "Imported scenario";
    file.seed = 99;
    file.countries.A = { industry: 90, shipbuilding: 25, stability: 0.3 };

    const { scenario } = applyScenarioFile(JSON.stringify(file), base, map);

    expect(scenario).not.toBe(base);
    expect(scenario.countries).not.toBe(base.countries);
    expect(scenario.countries.A).not.toBe(base.countries.A);
    expect(scenario.name).toBe(file.name);
    expect(scenario.seed).toBe(file.seed);
    expect(scenario.countries.A).toMatchObject(file.countries.A);
    expect(base).toEqual(original);
  });
});
